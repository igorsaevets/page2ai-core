// TLS cipher list on the wire (T227): every connection offers Mozilla's "intermediate" suites, not Node's default
// list, and a server that refuses them gets one retry with Node's defaults. The wire tests read the real ClientHello
// with a plain TCP server on 127.0.0.1 (no certificate needed: the hello arrives before any). The retry tests stub
// fetch, because the SSRF guard keeps fetchProtected away from 127.0.0.1.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  }),
}));

import {
  TLS_CIPHERS,
  _createPinnedAgent,
  _resetHostThrottle,
  fetchProtected,
  isTlsNegotiationFailure,
} from '../../src/node/fetch-protected.js';

// IANA TLS cipher suite ids of TLS_CIPHERS, in its order.
const MOZILLA_IDS = [0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8];
const RENEGOTIATION_SCSV = 0x00ff;

// The cipher suite ids of a TLS ClientHello record (RFC 8446 4.1.2), signalling values left out.
const parseClientHelloSuites = (buf: Buffer): number[] => {
  if (buf[0] !== 0x16 || buf[5] !== 0x01) throw new Error('not a ClientHello');
  let p = 9 + 2 + 32; // record header 5 + handshake header 4, legacy_version 2, random 32
  p += 1 + buf[p]; // legacy_session_id
  const len = buf.readUInt16BE(p);
  p += 2;
  const ids: number[] = [];
  for (let i = 0; i < len; i += 2) ids.push(buf.readUInt16BE(p + i));
  return ids.filter((id) => id !== RENEGOTIATION_SCSV && (id & 0x0f0f) !== 0x0a0a); // SCSV, GREASE
};

// A TCP server that records each connection's first bytes; `reply` decides what it sends back.
const helloServer = async (reply: (s: Socket) => void): Promise<{ server: Server; port: number; hellos: Buffer[] }> => {
  const hellos: Buffer[] = [];
  const server = createServer((s) => {
    let got = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      got = Buffer.concat([got, d]);
      // Wait for the whole first record before parsing or replying.
      if (got.length >= 5 && got.length >= 5 + got.readUInt16BE(3)) {
        hellos.push(got);
        reply(s);
      }
    });
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port, hellos };
};

const viaPinned = (port: number, profile: 'mozilla' | 'node-default') =>
  fetch(`https://pinned.test:${port}/`, {
    dispatcher: _createPinnedAgent([{ address: '127.0.0.1', family: 4 }], profile),
    signal: AbortSignal.timeout(5000),
  } as RequestInit);

describe('TLS cipher list on the wire', { timeout: 15_000 }, () => {
  let srv: { server: Server; port: number; hellos: Buffer[] };
  beforeEach(async () => { srv = await helloServer((s) => s.destroy()); });
  afterEach(() => new Promise<void>((r) => srv.server.close(() => r())));

  it('TLS_CIPHERS names the nine suites of the Mozilla intermediate configuration', () => {
    expect(TLS_CIPHERS.split(':')).toHaveLength(9);
  });

  it('offers exactly the Mozilla intermediate suites', async () => {
    await viaPinned(srv.port, 'mozilla').catch(() => {});
    expect(srv.hellos).toHaveLength(1);
    expect(parseClientHelloSuites(srv.hellos[0])).toEqual(MOZILLA_IDS);
  });

  it("control: Node's default list is longer and offers suites outside it", async () => {
    await viaPinned(srv.port, 'node-default').catch(() => {});
    const ids = parseClientHelloSuites(srv.hellos[0]);
    expect(ids.length).toBeGreaterThan(MOZILLA_IDS.length);
    expect(ids.some((id) => !MOZILLA_IDS.includes(id))).toBe(true);
  });
});

describe('a server that refuses the handshake', { timeout: 15_000 }, () => {
  it('the error a real handshake_failure alert produces is recognised as a TLS negotiation failure', async () => {
    // Fatal alert, handshake_failure (40): what a server sends when no offered suite is acceptable.
    const srv = await helloServer((s) => s.end(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28])));
    try {
      const err = await viaPinned(srv.port, 'mozilla').then(() => null, (e: unknown) => e);
      expect(err).not.toBeNull();
      expect(isTlsNegotiationFailure(err)).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.server.close(() => r()));
    }
  });

  it('a certificate error is not one', () => {
    const certErr = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }),
    });
    expect(isTlsNegotiationFailure(certErr)).toBe(false);
    expect(isTlsNegotiationFailure(new Error('boom'))).toBe(false);
    expect(isTlsNegotiationFailure(undefined)).toBe(false);
  });
});

describe('fetchProtected retries once with Node defaults after a refused handshake', () => {
  const page = () =>
    new Response('<html><body><p>retried page</p></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  const tlsFailure = (code: string) =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

  beforeEach(() => { _resetHostThrottle(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('handshake_failure: a second attempt on a new connection, and its page is returned', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(tlsFailure('ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE'))
      .mockResolvedValueOnce(page());
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchProtected('https://public.example/');
    expect(res.text).toContain('retried page');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = (fetchMock.mock.calls[0][1] as { dispatcher: unknown }).dispatcher;
    const second = (fetchMock.mock.calls[1][1] as { dispatcher: unknown }).dispatcher;
    expect(second).not.toBe(first);
  });

  it('a certificate error is not retried', async () => {
    const fetchMock = vi.fn().mockRejectedValue(tlsFailure('CERT_HAS_EXPIRED'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('https://public.example/')).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a refused handshake after the caller aborted is not retried', async () => {
    const ac = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      ac.abort();
      throw tlsFailure('ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('https://public.example/', { signal: ac.signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
