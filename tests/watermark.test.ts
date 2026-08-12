/**
 * §2.5 watermarking. The properties that matter are attribution WITHOUT
 * breaking integrity, caching, or a paying customer's access.
 */
import { describe, it, expect } from 'vitest';
import {
  applyWatermark, readWatermark, matchWatermark, watermarkToken, digestOf,
} from '../src/delivery/watermark';

const SECRET = 'test-watermark-secret';
const BUNDLE = Buffer.from('export const engine="premium";\nconsole.log("hi");\n');

describe('watermark', () => {
  it('marks a bundle and reads the token back', () => {
    const marked = applyWatermark(BUNDLE, SECRET, 'lic-abc');
    expect(readWatermark(marked)).toBe(watermarkToken(SECRET, 'lic-abc'));
  });

  it('NEVER embeds the licence id — the bundle is client-side code', () => {
    // Anyone can open devtools on their own editor. Embedding a customer id
    // would publish who your customers are to all of their end-users.
    const marked = applyWatermark(BUNDLE, SECRET, 'lic-acme-corp-secret').toString('utf8');
    expect(marked).not.toContain('acme');
    expect(marked).not.toContain('lic-acme-corp-secret');
  });

  it('is DETERMINISTIC — the same licence always yields the same bytes', () => {
    // This is what makes "generate once, cache forever" correct: a
    // non-deterministic marker would mint a new digest on every session and
    // destroy caching entirely.
    const a = applyWatermark(BUNDLE, SECRET, 'lic-1');
    const b = applyWatermark(BUNDLE, SECRET, 'lic-1');
    expect(digestOf(a)).toBe(digestOf(b));
  });

  it('gives DIFFERENT licences different digests — otherwise nothing is traceable', () => {
    const a = applyWatermark(BUNDLE, SECRET, 'lic-1');
    const b = applyWatermark(BUNDLE, SECRET, 'lic-2');
    expect(digestOf(a)).not.toBe(digestOf(b));
  });

  it('PRESERVES the original code byte-for-byte', () => {
    // The engine must not behave differently for one customer — that would be a
    // far worse bug than the leak this guards against.
    const marked = applyWatermark(BUNDLE, SECRET, 'lic-1');
    expect(marked.subarray(0, BUNDLE.length).equals(BUNDLE)).toBe(true);
  });

  it('traces a leaked bundle to the right customer', () => {
    const leaked = applyWatermark(BUNDLE, SECRET, 'lic-guilty');
    const found = matchWatermark(leaked, SECRET, ['lic-a', 'lic-guilty', 'lic-b']);
    expect(found).toBe('lic-guilty');
  });

  it('survives a MINIFIER that strips comments', () => {
    // A re-publisher would run a minifier. The runtime constant is the backup
    // marker for exactly that case.
    const marked = applyWatermark(BUNDLE, SECRET, 'lic-1').toString('utf8');
    const stripped = marked.replace(/\/\*![\s\S]*?\*\//g, '');
    expect(readWatermark(stripped)).toBe(watermarkToken(SECRET, 'lic-1'));
  });

  it('a bundle ending in a // comment is still marked (newline guard)', () => {
    const trailing = Buffer.from('const x=1; // trailing comment');
    const marked = applyWatermark(trailing, SECRET, 'lic-1');
    expect(readWatermark(marked)).toBeTruthy();
  });

  it('reports no match rather than guessing when the marker is stripped', () => {
    expect(readWatermark(BUNDLE)).toBeNull();
    expect(matchWatermark(BUNDLE, SECRET, ['lic-1'])).toBeNull();
  });

  it('a DIFFERENT secret cannot trace our bundles', () => {
    const leaked = applyWatermark(BUNDLE, SECRET, 'lic-1');
    expect(matchWatermark(leaked, 'wrong-secret', ['lic-1'])).toBeNull();
  });
});
