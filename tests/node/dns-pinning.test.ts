// Functional test: does Node's global fetch honour the npm undici Agent's
// connect.lookup? This is the mechanism @page2ai/core relies on for DNS
// pinning (BL-22, BL-52). The mock-level test in ssrf-guard.test.ts proves
// the code PASSES a dispatcher; this test proves the dispatcher WORKS —
// that the built-in undici inside Node's fetch actually calls the custom
// lookup from the npm undici Agent we hand it. If a future Node major
// breaks that pairing, this test fails while every mock test stays green.
//
// Approach: a real HTTP server on 127.0.0.1, a URL under the reserved
// .invalid TLD (RFC 6761 §6.4: MUST return NXDOMAIN). Without the pinned
// Agent the request cannot reach the server; with it, the custom lookup
// routes the connection to 127.0.0.1.

import { createServer, type Server } from 'node:http';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOST = 'pinned-check.invalid';
const MARKER = 'pinned-ok';

describe('DNS pinning — global fetch + npm undici Agent (BL-52)', { timeout: 15_000 }, () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body>${MARKER}</body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server?.close();
  });

  it('control: global fetch without a dispatcher does not reach the server', async () => {
    const url = `http://${HOST}:${port}/`;
    // .invalid MUST return NXDOMAIN (RFC 6761). Even if a broken resolver
    // answers, the response cannot come from our 127.0.0.1 server.
    const reached = await fetch(url)
      .then((r) => r.text())
      .then((t) => t.includes(MARKER))
      .catch(() => false);
    expect(reached).toBe(false);
  });

  it('pinned: global fetch with an npm undici Agent reaches the server', async () => {
    const url = `http://${HOST}:${port}/`;
    const agent = new Agent({
      connect: {
        lookup: (
          _hostname: string,
          options: { all?: boolean },
          callback: Function,
        ) => {
          if (options && options.all) {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
          } else {
            callback(null, '127.0.0.1', 4);
          }
        },
      },
    });
    try {
      // Node's fetch accepts `dispatcher` from undici but TypeScript's
      // RequestInit omits it — the production code uses the same cast.
      const resp = await fetch(url, {
        ...({ dispatcher: agent } as Record<string, unknown>),
      } as RequestInit);
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain(MARKER);
    } finally {
      await agent.close();
    }
  });
});
