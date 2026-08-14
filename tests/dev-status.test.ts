/**
 * dev-status.test.ts — the cleanup helper must never stop the server.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * `dev:status --fix` kills processes. The one thing it must never kill is the
 * backend actually serving the port — that would turn a tidy-up into an outage
 * on someone's machine mid-session.
 *
 * The guard is that a process is only a candidate if it holds NO port, and it
 * is re-checked immediately before the kill. This test asserts both, plus the
 * scoping that keeps it from touching an unrelated checkout.
 *
 * Source assertions, deliberately: the behaviour needs real processes and a
 * real port, which is flaky in CI and dangerous to simulate. It WAS verified
 * live — an orphaned `nest start --watch` was spawned, `--fix` stopped it, and
 * :8787/health kept returning 200 throughout. What this guards against is
 * someone later "simplifying" the guard away.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'scripts', 'dev-status.mjs'), 'utf-8');

describe('dev:status --fix safety', () => {
  it('only treats a process as an orphan when it holds no port', () => {
    expect(src).toMatch(/if \(!serving\) orphans\.push\(p\)/);
  });

  it('re-checks the listener immediately before killing', () => {
    // Belt and braces: even if the listener somehow reached the orphan list,
    // this stops it being killed.
    expect(src).toMatch(/if \(p\.pid === listener\) continue;/);
  });

  it('is scoped to THIS checkout, not every node process on the machine', () => {
    expect(src).toMatch(/p\.cmd\.includes\(here\)/);
    expect(src).toMatch(/dist\\\/main\|\\\.bin\\\/nest/);
  });

  it('never lists itself as a candidate', () => {
    expect(src).toMatch(/p\.pid !== String\(process\.pid\)/);
  });

  it('does nothing destructive without an explicit --fix', () => {
    expect(src).toMatch(/const FIX = process\.argv\.includes\('--fix'\)/);
    expect(src).toMatch(/if \(!FIX\)/);
  });
});
