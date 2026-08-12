/**
 * §2.3 push hub. The safety properties are the point, not the happy path.
 */
import { describe, it, expect } from 'vitest';
import {
  EntitlementEventsService, MAX_SUBSCRIBERS_PER_CHANNEL,
} from '../src/delivery/entitlement-events.service';

const svc = () => new EntitlementEventsService();

describe('EntitlementEventsService', () => {
  it('delivers to subscribers of a channel', () => {
    const s = svc(); const got: string[] = [];
    s.subscribe('lic-1', (e) => got.push(e.reason));
    expect(s.publish('lic-1', 'purchased')).toBe(1);
    expect(got).toEqual(['purchased']);
  });

  it('never leaks across channels — one customer cannot see another', () => {
    const s = svc(); const a: string[] = []; const b: string[] = [];
    s.subscribe('lic-a', (e) => a.push(e.reason));
    s.subscribe('lic-b', (e) => b.push(e.reason));
    s.publish('lic-a', 'revoked');
    expect(a).toEqual(['revoked']);
    expect(b).toEqual([]);
  });

  it('publishing to nobody is 0, not an error (normal: no tab open)', () => {
    expect(svc().publish('nobody', 'changed')).toBe(0);
  });

  it('unsubscribe removes the listener AND the empty channel', () => {
    // Without deleting the empty Set, `channels` grows forever with dead keys
    // and the cap eventually refuses real customers.
    const s = svc();
    const off = s.subscribe('lic-1', () => {});
    expect(s.stats().channels).toBe(1);
    off!();
    expect(s.stats()).toEqual({ channels: 0, subscribers: 0 });
  });

  it('ONE WEDGED LISTENER CANNOT STARVE THE OTHERS', () => {
    // A throwing listener is dropped and the rest still receive the event.
    const s = svc(); const good: string[] = [];
    s.subscribe('lic-1', () => { throw new Error('wedged'); });
    s.subscribe('lic-1', (e) => good.push(e.reason));
    expect(s.publish('lic-1', 'changed')).toBe(1);
    expect(good).toEqual(['changed']);
    expect(s.stats().subscribers).toBe(1); // the thrower was removed
  });

  it('caps subscribers per channel — a public endpoint cannot be grown without limit', () => {
    const s = svc();
    for (let i = 0; i < MAX_SUBSCRIBERS_PER_CHANNEL; i += 1) {
      expect(s.subscribe('lic-1', () => {})).toBeTruthy();
    }
    // Refused, NOT thrown: the editor must fall back to its timer, not fail.
    expect(s.subscribe('lic-1', () => {})).toBeNull();
  });

  it('ignores an empty channel key', () => {
    const s = svc();
    expect(s.subscribe('', () => {})).toBeNull();
    expect(s.publish('', 'changed')).toBe(0);
  });
});
