import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DNS is mocked so no test touches the network (same map as ssrf-guard.test.ts).
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
    if (host === 'other.example') return [{ address: '198.51.99.7', family: 4 }];
    if (host === 'v6.example') return [{ address: '2001:4860:4860::8888', family: 6 }];
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  }),
}));

import { fetchProtected, _resetHostThrottle } from '../../src/node/fetch-protected.js';
import { runWithFetchSignal, resolveFetchPolicy } from '../../src/node/fetch-policy.js';
import { findIpBlockReason } from '../../src/node/ssrf-guard.js';
import { fetchAndConvert } from '../../src/node/index.js';

const page = () =>
  new Response('<html><body><article><p>policy page</p></article></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

beforeEach(() => {
  _resetHostThrottle();
  delete process.env.PAGE2AI_ALLOWED_PORTS;
  delete process.env.PAGE2AI_EXTRA_BLOCKED_IPS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PAGE2AI_ALLOWED_PORTS;
  delete process.env.PAGE2AI_EXTRA_BLOCKED_IPS;
});

describe('allowed ports', () => {
  it('refuses a port outside the list before any request', async () => {
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('http://public.example:8080/', { allowedPorts: [80, 443] }))
      .rejects.toThrow(/SSRF guard.*port 8080 is not allowed \(allowed: 80, 443\)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes the scheme default when the URL names no port', async () => {
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchProtected('https://public.example/', { allowedPorts: [80, 443] });
    expect(res.text).toContain('policy page');
    // An explicit default port is the same port.
    _resetHostThrottle();
    await expect(fetchProtected('http://public.example:80/', { allowedPorts: [443] }))
      .rejects.toThrow(/port 80 is not allowed/);
  });

  it('refuses a redirect hop to another port before following it', async () => {
    const fetchMock = vi.fn(async () => redirectTo('http://public.example:22/'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('https://public.example/start', { allowedPorts: [80, 443] }))
      .rejects.toThrow(/port 22 is not allowed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads PAGE2AI_ALLOWED_PORTS when the call names no list; an option wins', async () => {
    process.env.PAGE2AI_ALLOWED_PORTS = ' 80 , 443 ';
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('http://public.example:3000/')).rejects.toThrow(/port 3000 is not allowed/);
    _resetHostThrottle();
    await expect(fetchProtected('http://public.example:3000/', { allowedPorts: [3000] })).resolves.toBeTruthy();
  });

  it('fails every fetch when the variable does not parse, so a typo never leaves the server open', async () => {
    process.env.PAGE2AI_ALLOWED_PORTS = '80,https';
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('https://public.example/')).rejects.toThrow(/PAGE2AI_ALLOWED_PORTS: "https"/);
    process.env.PAGE2AI_ALLOWED_PORTS = '70000';
    await expect(fetchProtected('https://public.example/')).rejects.toThrow(/not a port number/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => resolveFetchPolicy({ allowedPorts: [] })).toThrow(/empty list/);
    expect(() => resolveFetchPolicy({ allowedPorts: [0] })).toThrow(/not a port number/);
  });

  it('is off by default: any port, as before', async () => {
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('http://public.example:8080/')).resolves.toBeTruthy();
    expect(resolveFetchPolicy()).toEqual({ ports: null, blocked: null });
  });
});

describe('extra blocked addresses', () => {
  it('refuses an IP literal on the list before any request', async () => {
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('http://93.184.216.34/', { extraBlockedIps: ['93.184.216.34'] }))
      .rejects.toThrow(/address 93\.184\.216\.34 is not allowed on this server/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves into a listed range, without naming the address', async () => {
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    const err = await fetchProtected('http://public.example/', { extraBlockedIps: ['93.184.216.0/24'] })
      .then(() => new Error('resolved'), (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/hostname "public\.example" resolves to an address that is not allowed on this server/);
    expect(err.message).not.toContain('93.184.216');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a redirect hop whose host resolves onto the list', async () => {
    const fetchMock = vi.fn(async () => redirectTo('http://public.example/landing'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('http://other.example/', { extraBlockedIps: ['93.184.216.34'] }))
      .rejects.toThrow(/not allowed on this server/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads PAGE2AI_EXTRA_BLOCKED_IPS, IPv6 ranges included', async () => {
    process.env.PAGE2AI_EXTRA_BLOCKED_IPS = '203.0.112.9, 2001:4860::/32';
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('http://[2001:4860:0:0::8888]/')).rejects.toThrow(/not allowed on this server/);
    await expect(fetchProtected('http://v6.example/')).rejects.toThrow(/not allowed on this server/);
    await expect(fetchProtected('http://public.example/')).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails every fetch on an entry that is not an address or a range', async () => {
    process.env.PAGE2AI_EXTRA_BLOCKED_IPS = '93.184.216.34,server.example';
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProtected('http://other.example/')).rejects.toThrow(/"server\.example" is not an IP address/);
    process.env.PAGE2AI_EXTRA_BLOCKED_IPS = '93.184.216.0/33';
    await expect(fetchProtected('http://other.example/')).rejects.toThrow(/no valid prefix length/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchAndConvert passes the policy along', () => {
  it('refuses through the options of fetchAndConvert', async () => {
    const fetchMock = vi.fn(async () => page());
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAndConvert('http://public.example:8443/', { allowedPorts: [443] }))
      .rejects.toThrow(/port 8443 is not allowed/);
    await expect(fetchAndConvert('http://public.example/', { extraBlockedIps: ['93.184.216.34'] }))
      .rejects.toThrow(/not allowed on this server/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('abort signal', () => {
  // A fetch that never answers until its signal aborts.
  const hanging = () =>
    vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (init.signal?.aborted) fail();
        init.signal?.addEventListener('abort', fail);
      }));

  it('reaches fetchProtected through runWithFetchSignal and ends it as an AbortError', async () => {
    vi.stubGlobal('fetch', hanging());
    const ac = new AbortController();
    const started = Date.now();
    const pending = runWithFetchSignal(ac.signal, () => fetchProtected('http://public.example/', { timeoutMs: 10_000 }));
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops at once on a signal that is already aborted (option)', async () => {
    vi.stubGlobal('fetch', hanging());
    await expect(fetchProtected('http://public.example/', { signal: AbortSignal.abort(), timeoutMs: 10_000 }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('leaves calls outside the run alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page()));
    const ac = new AbortController();
    ac.abort();
    await runWithFetchSignal(ac.signal, async () => undefined);
    await expect(fetchProtected('http://public.example/')).resolves.toBeTruthy();
  });
});

describe('IANA special-purpose ranges', () => {
  it('blocks AS112-v4, AMT and Direct Delegation AS112, not their neighbours', () => {
    expect(findIpBlockReason('192.31.196.1')).toMatch(/private range/);
    expect(findIpBlockReason('192.52.193.9')).toMatch(/private range/);
    expect(findIpBlockReason('192.175.48.42')).toMatch(/private range/);
    expect(findIpBlockReason('192.31.197.1')).toBeNull();
    expect(findIpBlockReason('192.175.49.1')).toBeNull();
  });
});
