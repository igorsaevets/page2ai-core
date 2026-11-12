import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProxyForUrl } from '../../src/node/fetch-protected.js';

// Snapshot and restore the proxy env vars around every test so tests are
// independent and do not leak into the rest of the suite.
const PROXY_VARS = [
  'http_proxy', 'HTTP_PROXY',
  'https_proxy', 'HTTPS_PROXY',
  'no_proxy', 'NO_PROXY',
] as const;

const saved = new Map<string, string | undefined>();

const saveEnv = (): void => {
  for (const k of PROXY_VARS) saved.set(k, process.env[k]);
};
const clearEnv = (): void => {
  for (const k of PROXY_VARS) delete process.env[k];
};
const restoreEnv = (): void => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
};

describe('getProxyForUrl — env-var resolution', () => {
  beforeEach(() => { saveEnv(); clearEnv(); });
  afterEach(restoreEnv);

  it('returns null when no proxy env vars are set', () => {
    expect(getProxyForUrl(new URL('https://example.com/'))).toBeNull();
    expect(getProxyForUrl(new URL('http://example.com/'))).toBeNull();
  });

  it('reads HTTPS_PROXY for https targets', () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    expect(getProxyForUrl(new URL('https://example.com/'))).toBe('http://proxy:8080');
  });

  it('reads HTTP_PROXY for http targets', () => {
    process.env.HTTP_PROXY = 'http://proxy:3128';
    expect(getProxyForUrl(new URL('http://example.com/'))).toBe('http://proxy:3128');
  });

  it('lowercase env vars take precedence', () => {
    process.env.HTTPS_PROXY = 'http://upper:1';
    process.env.https_proxy = 'http://lower:2';
    expect(getProxyForUrl(new URL('https://example.com/'))).toBe('http://lower:2');
  });

  it('does not use HTTPS_PROXY for http targets', () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    expect(getProxyForUrl(new URL('http://example.com/'))).toBeNull();
  });

  it('does not use HTTP_PROXY for https targets', () => {
    process.env.HTTP_PROXY = 'http://proxy:3128';
    expect(getProxyForUrl(new URL('https://example.com/'))).toBeNull();
  });
});

describe('getProxyForUrl — NO_PROXY matching', () => {
  beforeEach(() => {
    saveEnv();
    clearEnv();
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    process.env.HTTP_PROXY = 'http://proxy:8080';
  });
  afterEach(restoreEnv);

  it('NO_PROXY=* bypasses all targets', () => {
    process.env.NO_PROXY = '*';
    expect(getProxyForUrl(new URL('https://example.com/'))).toBeNull();
    expect(getProxyForUrl(new URL('http://internal.corp/'))).toBeNull();
  });

  it('exact hostname match', () => {
    process.env.NO_PROXY = 'example.com';
    expect(getProxyForUrl(new URL('https://example.com/'))).toBeNull();
    expect(getProxyForUrl(new URL('https://other.com/'))).toBe('http://proxy:8080');
  });

  it('subdomain match without leading dot', () => {
    process.env.NO_PROXY = 'example.com';
    expect(getProxyForUrl(new URL('https://sub.example.com/'))).toBeNull();
  });

  it('subdomain match with leading dot', () => {
    process.env.NO_PROXY = '.example.com';
    expect(getProxyForUrl(new URL('https://sub.example.com/'))).toBeNull();
    // exact match does not work with a leading dot — "example.com" does not end with ".example.com"
    expect(getProxyForUrl(new URL('https://example.com/'))).toBe('http://proxy:8080');
  });

  it('comma-separated list', () => {
    process.env.NO_PROXY = 'foo.com, bar.com, baz.com';
    expect(getProxyForUrl(new URL('https://bar.com/'))).toBeNull();
    expect(getProxyForUrl(new URL('https://qux.com/'))).toBe('http://proxy:8080');
  });

  it('port-specific NO_PROXY', () => {
    process.env.NO_PROXY = 'example.com:443';
    expect(getProxyForUrl(new URL('https://example.com/'))).toBeNull();
    expect(getProxyForUrl(new URL('http://example.com/'))).toBe('http://proxy:8080');
  });

  it('lowercase no_proxy takes precedence', () => {
    process.env.NO_PROXY = 'wrong.com';
    process.env.no_proxy = 'example.com';
    expect(getProxyForUrl(new URL('https://example.com/'))).toBeNull();
    expect(getProxyForUrl(new URL('https://wrong.com/'))).toBe('http://proxy:8080');
  });

  it('case insensitive hostname match', () => {
    process.env.NO_PROXY = 'Example.COM';
    expect(getProxyForUrl(new URL('https://example.com/'))).toBeNull();
  });
});

// Mock DNS so no test touches the network.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
    if (host === 'rebind.example') return [{ address: '169.254.169.254', family: 4 }];
    throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  }),
}));

import { fetchProtected } from '../../src/node/fetch-protected.js';

describe('fetchProtected — proxy integration', () => {
  beforeEach(() => { saveEnv(); clearEnv(); });
  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
  });

  it('uses a ProxyAgent as dispatcher when HTTPS_PROXY is set', async () => {
    process.env.HTTPS_PROXY = 'http://corp-proxy:8080';

    const fetchMock = vi.fn(async () =>
      new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchProtected('https://public.example/page');

    const args = fetchMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[1]).toHaveProperty('dispatcher');
    const d = args[1].dispatcher as { constructor: { name: string } };
    expect(d.constructor.name).toBe('ProxyAgent');
  });

  it('uses a pinned Agent (not ProxyAgent) when NO_PROXY matches', async () => {
    process.env.HTTPS_PROXY = 'http://corp-proxy:8080';
    process.env.NO_PROXY = 'public.example';

    const fetchMock = vi.fn(async () =>
      new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchProtected('https://public.example/page');

    const args = fetchMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[1]).toHaveProperty('dispatcher');
    const d = args[1].dispatcher as { constructor: { name: string } };
    expect(d.constructor.name).toBe('Agent');
  });

  it('SSRF string checks still block internal URLs even with proxy', async () => {
    process.env.HTTPS_PROXY = 'http://corp-proxy:8080';

    await expect(fetchProtected('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(/SSRF|private/);
  });

  it('advisory DNS check blocks a rebinding name even through proxy', async () => {
    process.env.HTTPS_PROXY = 'http://corp-proxy:8080';

    await expect(fetchProtected('http://rebind.example/'))
      .rejects.toThrow(/SSRF|blocked/);
  });

  // Until 0.4.3 an IP literal went through Node's global dispatcher. Since 0.4.4 every hop gets an Agent of
  // its own, because the TLS cipher list (TLS_CIPHERS) is set on the dispatcher; there is still nothing to pin.
  it('a plain Agent (not a ProxyAgent) when no proxy and target is an IP literal', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchProtected('http://93.184.216.34/page');

    const args = fetchMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[1]).toHaveProperty('dispatcher');
    const d = args[1].dispatcher as { constructor: { name: string } };
    expect(d.constructor.name).toBe('Agent');
  });
});

import { beforeEach } from 'vitest';
