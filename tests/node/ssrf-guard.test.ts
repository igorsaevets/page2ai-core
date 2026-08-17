import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock DNS so no test touches the network. Hostnames map to fixed addresses;
// anything else fails like ENOTFOUND.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
    if (host === 'rebind.example') return [{ address: '169.254.169.254', family: 4 }];
    if (host === 'halfbad.example') {
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ];
    }
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  }),
}));

import {
  assertSafeUrl,
  assertSafeUrlResolved,
  findIpBlockReason,
} from '../../src/node/ssrf-guard.js';
import { fetchProtected } from '../../src/node/fetch-protected.js';

describe('assertSafeUrl — string layer', () => {
  it('blocks the metadata hostname with a trailing dot', () => {
    // "metadata.google.internal." resolves to the same host as without the
    // dot; the v0.1 guard let it through because the set lookup was exact.
    expect(() => assertSafeUrl('http://metadata.google.internal./')).toThrow(/blocked/);
    expect(() => assertSafeUrl('http://localhost./x')).toThrow(/blocked/);
  });

  it('still blocks the classic literals', () => {
    expect(() => assertSafeUrl('http://127.0.0.1/')).toThrow(/private range/);
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/private/);
    expect(() => assertSafeUrl('https://[::1]/')).toThrow(/IPv6/);
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(/scheme/);
  });

  it('allows normal public URLs', () => {
    expect(() => assertSafeUrl('https://example.com/page')).not.toThrow();
  });
});

describe('findIpBlockReason — pure address checks', () => {
  it('flags private and special addresses', () => {
    for (const bad of [
      '127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1',
      '192.168.1.1', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(findIpBlockReason(bad), bad).not.toBeNull();
    }
  });

  it('passes public addresses', () => {
    for (const good of ['93.184.216.34', '8.8.8.8', '2606:4700::6810:84e5']) {
      expect(findIpBlockReason(good), good).toBeNull();
    }
  });
});

describe('assertSafeUrlResolved — DNS layer', () => {
  it('blocks a public-looking name that resolves to a metadata address', async () => {
    await expect(assertSafeUrlResolved('http://rebind.example/'))
      .rejects.toThrow(/resolves to blocked address 169\.254\.169\.254/);
  });

  it('blocks when ANY resolved address is internal', async () => {
    await expect(assertSafeUrlResolved('http://halfbad.example/'))
      .rejects.toThrow(/127\.0\.0\.1/);
  });

  it('fails closed on DNS errors', async () => {
    await expect(assertSafeUrlResolved('http://no-such-host.example/'))
      .rejects.toThrow(/DNS resolution failed/);
  });

  it('passes a name resolving only to public addresses', async () => {
    await expect(assertSafeUrlResolved('http://public.example/')).resolves.toBeTruthy();
  });
});

describe('fetchProtected — manual redirect handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a redirect into an internal address BEFORE following it', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProtected('http://public.example/start'))
      .rejects.toThrow(/SSRF/);
    // The internal hop must never have been requested: one fetch call only.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never fetches a hostname whose DNS points at an internal address', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('http://rebind.example/')).rejects.toThrow(/SSRF/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a safe redirect chain and returns the final URL', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://public.example/a') {
        return new Response(null, {
          status: 301,
          headers: { location: 'http://public.example/b' },
        });
      }
      return new Response('<html><body><article><p>done</p></article></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchProtected('http://public.example/a');
    expect(res.finalUrl).toBe('http://public.example/b');
    expect(res.text).toContain('done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after too many redirects', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return new Response(null, {
        status: 302,
        headers: { location: `http://public.example/hop${n}` },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProtected('http://public.example/start'))
      .rejects.toThrow(/redirects/);
  });
});
