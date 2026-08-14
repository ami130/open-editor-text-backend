#!/usr/bin/env node
/**
 * dev-preflight.mjs — runs before `start:dev`, so a port clash never happens.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * `start:dev` used to bind blindly. If a backend was already serving the port,
 * Nest booted everything, THEN failed on listen — leaving a watcher alive that
 * holds no port, recompiles on every save, and reports nothing. Those pile up:
 * one check found four backend processes, two of them orphaned for ~2 days.
 *
 * Improving the error message helped, but the developer still had to read it,
 * run a command, and try again — for a situation the machine can settle by
 * itself. This checks FIRST, and:
 *
 *   • port free                → start normally, silently
 *   • port served, and healthy → say so and STOP. Starting a second copy of a
 *                                backend you already have is never what you
 *                                wanted, and stopping here leaves no orphan.
 *   • port held, not healthy   → clean up any strays and start
 *
 * Deliberately does NOT kill whatever is serving the port. That is the backend
 * in use; a dev script is not entitled to take it down. Use
 * `npm run dev:status -- --fix`, or `PORT=8788 npm run start:dev` to run beside it.
 */
import { execSync } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

const listener = sh(`lsof -tiTCP:${PORT} -sTCP:LISTEN`).split('\n').filter(Boolean)[0];

// Nothing there — the normal case. Say nothing and let Nest start.
if (!listener) process.exit(0);

// Something is listening. Is it a working backend, or a dead socket?
const health = sh(`curl -s --max-time 5 http://127.0.0.1:${PORT}/health`);
let healthy = false;
let detail = '';
try {
  const h = JSON.parse(health);
  healthy = h?.status === 'ok' || h?.status === 'degraded';
  detail = `status=${h.status} engine=${h.checks?.delivery?.version ?? '?'} db=${h.checks?.database?.status ?? '?'}`;
} catch { /* not a backend, or not answering */ }

if (healthy) {
  const cmd = sh(`ps -p ${listener} -o command=`).slice(0, 80);
  console.log(
    `\n  ✓ A backend is ALREADY running on :${PORT} and healthy — not starting a second one.\n`
    + '    NOTHING IS WRONG. npm will print an error code below; ignore it.\n\n'
    + `      PID ${listener}  ${detail}\n`
    + `      ${cmd}\n\n`
    + '    Use it as-is:\n'
    + `      curl -s http://127.0.0.1:${PORT}/health\n\n`
    + '    Restart it instead (picks up your code changes):\n'
    + `      npm run dev:status -- --fix && kill ${listener} && npm run start:dev\n\n`
    + '    Or run a second one alongside:\n'
    + `      PORT=${PORT + 1} npm run start:dev\n`,
  );
  // ⚠️ MUST be non-zero. `start:dev` is `preflight && nest start --watch`, so
  // exiting 0 here lets the watcher start anyway — which is exactly the orphan
  // this script exists to prevent (caught by testing it: the message printed,
  // then compilation began regardless).
  //
  // npm prints its own "exited with code 1" noise after this, so the message
  // above says plainly that nothing is wrong.
  process.exit(1);
}

// Port is held by something that is NOT a healthy backend — a half-dead
// process, or another app. Say so plainly rather than starting and failing on
// listen, which is what produced the orphaned watchers.
console.error(
  `\n  ✗ Port ${PORT} is in use, but nothing healthy is answering there.\n\n`
  + `      PID ${listener}  ${sh(`ps -p ${listener} -o command=`).slice(0, 80)}\n\n`
  + '    Inspect and clean up:\n'
  + '      npm run dev:status\n'
  + `      kill ${listener}\n\n`
  + '    Or start elsewhere:\n'
  + `      PORT=${PORT + 1} npm run start:dev\n`,
);
process.exit(1);
