/**
 * port-in-use.test.ts — EADDRINUSE must explain itself.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Starting a second backend while one is already running printed a raw Node
 * stack trace naming `net.js` internals:
 *
 *   Error: listen EADDRINUSE: address already in use :::8787
 *       at Server.setupListenHandle [as _listen2] (node:net:1940:16)
 *       ...
 *
 * Nothing in that says "you already have one running", and nothing says what to
 * do about it. It cost real time more than once. main.ts now catches the code
 * and prints the cause plus three concrete fixes (inspect / kill / use another
 * port), all of which were verified by hand against a real collision.
 *
 * This test guards the SHAPE of that guidance rather than starting two servers:
 * a real bind race in CI would be flaky, and the failure mode worth preventing
 * is someone "tidying" the handler away, which a source assertion catches
 * exactly. The behaviour itself was proven live — second instance printed the
 * message, and `PORT=8788` came up healthy on 200 while 8787 stayed untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const main = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf-8');

describe('EADDRINUSE guidance', () => {
  it('catches the listen failure instead of letting it crash raw', () => {
    expect(main).toMatch(/EADDRINUSE/);
    expect(main).toMatch(/await app\.listen\(port\)/);
  });

  it('rethrows anything that is NOT a port clash', () => {
    // Without this, a genuinely different startup failure would be reported as
    // "port in use" and send you chasing a process that does not exist.
    expect(main).toMatch(/code\s*!==\s*'EADDRINUSE'\)\s*throw err/);
  });

  it('tells the operator how to find the process holding the port', () => {
    expect(main).toMatch(/lsof -nP -iTCP:\$\{port\} -sTCP:LISTEN/);
  });

  it('tells them how to stop it', () => {
    expect(main).toMatch(/kill \$\(lsof -tiTCP:\$\{port\} -sTCP:LISTEN\)/);
  });

  it('offers a way to run anyway, on another port', () => {
    // Verified live: PORT=8788 came up healthy while 8787 stayed untouched.
    expect(main).toMatch(/PORT=\$\{port \+ 1\}/);
  });

  it('exits non-zero so a supervisor does not treat it as a clean start', () => {
    expect(main).toMatch(/process\.exit\(1\)/);
  });
});
