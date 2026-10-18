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
      // the whole of link-local fe80::/10, not only the fe80: prefix (T109: fe90::1 passed)
      'fe90::1', 'fea0::1', 'febf:ffff::1',
    ]) {
      expect(findIpBlockReason(bad), bad).not.toBeNull();
    }
  });

  it('passes public addresses', () => {
    for (const good of ['93.184.216.34', '8.8.8.8', '2606:4700::6810:84e5']) {
      expect(findIpBlockReason(good), good).toBeNull();
    }
  });

  it('blocks IPv4 broadcast and multicast', () => {
    for (const bad of ['255.255.255.255', '224.0.0.1', '239.255.255.255', '240.0.0.1']) {
      expect(findIpBlockReason(bad), bad).not.toBeNull();
    }
  });

  it('blocks IPv4 TEST-NET and benchmarking ranges', () => {
    for (const bad of [
      '192.0.2.1',     // TEST-NET-1
      '198.51.100.1',  // TEST-NET-2
      '203.0.113.1',   // TEST-NET-3
      '198.18.0.1',    // benchmarking low
      '198.19.255.255', // benchmarking high
      '192.0.0.1',     // IETF Protocol Assignments
      '192.88.99.1',   // deprecated 6to4 relay anycast
    ]) {
      expect(findIpBlockReason(bad), bad).not.toBeNull();
    }
  });

  it('blocks NAT64, 6to4, documentation, Teredo, discard IPv6 ranges', () => {
    for (const bad of [
      '64:ff9b::7f00:1',        // NAT64 well-known → 127.0.0.1
      '64:ff9b::a9fe:a9fe',     // NAT64 well-known → 169.254.169.254
      '64:ff9b:1::7f00:1',      // NAT64 local-use (RFC 8215)
      '2002:7f00:1::1',         // 6to4 → 127.0.0.1
      '2002:c0a8:1::1',         // 6to4 → 192.168.1.x
      '2001:db8::1',            // documentation
      '2001:db8:85a3::8a2e:370:7334', // documentation
      '2001::1',                // Teredo (canonical form with ::)
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo (explicit group 1 = 0)
      '100::1',                 // discard-only
    ]) {
      expect(findIpBlockReason(bad), bad).not.toBeNull();
    }
  });

  it('does NOT block legitimate 2001:x addresses outside Teredo/documentation', () => {
    for (const good of [
      '2001:4860:4860::8888',   // Google Public DNS
      '2001:4860:4860::8844',   // Google Public DNS
    ]) {
      expect(findIpBlockReason(good), good).toBeNull();
    }
  });

  it('does NOT block public addresses adjacent to blocked ranges', () => {
    for (const good of [
      '172.32.0.1',    // above RFC1918 172.16/12
      '100.128.0.1',   // above CGNAT 100.64/10
      '192.0.3.1',     // above TEST-NET-1
      '192.88.100.1',  // above deprecated 6to4 relay
      '223.255.255.255', // below multicast (last Class C)
    ]) {
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

  it('pins DNS: fetch receives a dispatcher so the runtime cannot re-resolve to a different address', async () => {
    // DNS rebinding: first call returns public, second would return private.
    // With pinning, fetch() must use the first (validated) addresses, not re-resolve.
    const { lookup: lookupMock } = await import('node:dns/promises');
    const castLookup = lookupMock as unknown as ReturnType<typeof vi.fn>;
    castLookup.mockImplementation(async (host: string) => {
      if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    });

    const fetchMock = vi.fn(async () =>
      new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchProtected('http://public.example/page');

    // The critical assertion: fetch was called with a dispatcher option (the pinned Agent)
    const args = fetchMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[1]).toHaveProperty('dispatcher');
    expect(args[1].dispatcher).toBeTruthy();
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
