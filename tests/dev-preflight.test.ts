/**
 * dev-preflight.test.ts — `start:dev` must not create orphaned watchers.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * `start:dev` used to bind blindly. With a backend already on the port, Nest
 * booted everything and THEN failed on listen, leaving a watcher alive that
 * holds no port, recompiles on every save, and is reported by nothing. They
 * accumulate: one check found four backend processes, two orphaned for ~2 days.
 *
 * The preflight makes the clash impossible instead of merely legible.
 *
 * ─── THE ASSERTION THAT MATTERS ─────────────────────────────────────────────
 * The exit code. `start:dev` is `preflight && nest start --watch`, so exiting 0
 * on "already running" lets the watcher start anyway — recreating the exact
 * orphan this prevents. That was not theoretical: the first version exited 0,
 * printed its message, and compilation began regardless. Hence the test below.
 *
 * Source assertions, deliberately: the behaviour needs real ports and real
 * processes, which is flaky in CI. It WAS verified live in all four cases —
 * free port (silent, exit 0), healthy backend (refuses, NO watcher created),
 * non-backend on the port (refuses, exit 1), and a full start on a free port
 * (came up healthy on :8793).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const src = readFileSync(join(root, 'scripts', 'dev-preflight.mjs'), 'utf-8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

describe('start:dev preflight', () => {
  it('runs before the watcher, chained so a refusal stops it', () => {
    expect(pkg.scripts['start:dev']).toBe('node scripts/dev-preflight.mjs && nest start --watch');
  });

  it('exits NON-ZERO when a healthy backend already holds the port', () => {
    // The whole point. Exit 0 here would let `&&` start the watcher anyway.
    const healthyBranch = src.slice(src.indexOf('if (healthy)'), src.indexOf('// Port is held by'));
    expect(healthyBranch).toMatch(/process\.exit\(1\)/);
    expect(healthyBranch).not.toMatch(/process\.exit\(0\)/);
  });

  it('exits zero, and silently, when the port is free', () => {
    expect(src).toMatch(/if \(!listener\) process\.exit\(0\)/);
  });

  it('never kills whatever is serving the port', () => {
    // A dev script may refuse to start; it may not take down the backend
    // someone is using. Cleanup is opt-in via `dev:status -- --fix`.
    expect(src).not.toMatch(/process\.kill/);
    expect(src).not.toMatch(/execSync\(\s*[`'"]kill /);
  });

  it('distinguishes a healthy backend from any other port holder', () => {
    // Different situations, different advice: "you already have one" versus
    // "something else is on this port".
    expect(src).toMatch(/\/health/);
    expect(src).toMatch(/healthy = h\?\.status === 'ok'/);
  });

  it('tells the operator the state is fine, since npm prints an error code', () => {
    expect(src).toMatch(/NOTHING IS WRONG/);
  });
});
