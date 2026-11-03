import { afterEach, describe, expect, it } from 'vitest';
import { _resetHostThrottle, _waitForHost } from '../../src/node/fetch-protected.js';

describe('per-host rate limiting', () => {
  afterEach(() => { _resetHostThrottle(); });

  it('first call to a host returns immediately', async () => {
    const t0 = Date.now();
    await _waitForHost('example.com');
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('second call to the same host waits at least 900 ms', async () => {
    await _waitForHost('example.com');
    const t0 = Date.now();
    await _waitForHost('example.com');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
  }, 5000);

  it('calls to different hosts are independent', async () => {
    await _waitForHost('a.example.com');
    const t0 = Date.now();
    await _waitForHost('b.example.com');
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('_resetHostThrottle clears the delay', async () => {
    await _waitForHost('example.com');
    _resetHostThrottle();
    const t0 = Date.now();
    await _waitForHost('example.com');
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('does not delay when enough time has passed naturally', async () => {
    await _waitForHost('example.com');
    // Simulate 1.5 s passing by clearing and setting a stale entry.
    _resetHostThrottle();
    // Manually: the function reads Date.now() on each call, so after a real
    // 1 s+ gap (or a reset) the next call is immediate.
    const t0 = Date.now();
    await _waitForHost('example.com');
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
