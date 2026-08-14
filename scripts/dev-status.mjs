#!/usr/bin/env node
/**
 * dev-status.mjs — what is running, and clean up what should not be.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * `EADDRINUSE: address already in use :::8787` kept recurring, and the answer
 * was never obvious from the error. On one check there were FOUR backend
 * processes: one serving the port, and three orphaned `nest start --watch`
 * watchers — two of which had been running for nearly two days, recompiling on
 * every file save, holding no port and doing nothing useful.
 *
 * A watcher that survives its terminal is invisible: it does not appear in any
 * window, it does not hold a port, and nothing ever reports it. So this makes
 * the state visible in one command.
 *
 *   npm run dev:status          show what is running
 *   npm run dev:status -- --fix stop the orphans, keep the one serving the port
 *
 * `--fix` is deliberately conservative: it NEVER stops a process that is
 * listening. Whatever is serving :8787 is the backend you are using, and this
 * script is not entitled to decide otherwise.
 */
import { execSync } from 'node:child_process';

const PORT = Number(process.env.PORT || 8787);
const FIX = process.argv.includes('--fix');

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

// Who is listening on the port?
const listener = sh(`lsof -tiTCP:${PORT} -sTCP:LISTEN`).split('\n').filter(Boolean)[0] || null;

// Every backend process belonging to THIS checkout. Scoped to the directory so
// a second clone, or an unrelated node process, is never touched.
const here = process.cwd();
const psLines = sh('ps -Ao pid=,etime=,command=').split('\n').filter(Boolean);
const mine = psLines
  .map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    return m ? { pid: m[1], etime: m[2], cmd: m[3] } : null;
  })
  .filter(Boolean)
  .filter((p) => p.cmd.includes(here) && /dist\/main|\.bin\/nest/.test(p.cmd))
  // Never list this script itself.
  .filter((p) => p.pid !== String(process.pid));

console.log(`\n  backend processes for ${here}\n`);
if (!mine.length) {
  console.log('    (none running)\n');
  process.exit(0);
}

const orphans = [];
for (const p of mine) {
  const serving = p.pid === listener;
  const kind = /\.bin\/nest/.test(p.cmd) ? 'watcher' : 'server ';
  const age = p.etime.includes('-') ? `${p.etime}  ← STALE, running for days` : p.etime;
  console.log(`    PID ${p.pid.padEnd(7)} ${kind}  up ${age.padEnd(28)} ${serving ? `serving :${PORT}` : 'no port'}`);
  if (!serving) orphans.push(p);
}

if (listener) {
  const health = sh(`curl -s --max-time 5 http://127.0.0.1:${PORT}/health`);
  if (health) {
    try {
      const h = JSON.parse(health);
      console.log(`\n    :${PORT} is healthy — status=${h.status} engine=${h.checks?.delivery?.version}`);
    } catch { /* not JSON; leave it */ }
  }
} else {
  console.log(`\n    nothing is listening on :${PORT}`);
}

if (!orphans.length) {
  console.log('\n    Nothing to clean up.\n');
  process.exit(0);
}

console.log(`\n    ${orphans.length} process(es) hold no port. These are almost always watchers`);
console.log('    left behind by a closed terminal — they recompile on every save and');
console.log('    are what makes a later start fail with EADDRINUSE.\n');

if (!FIX) {
  console.log('    Stop them with:  npm run dev:status -- --fix\n');
  process.exit(0);
}

for (const p of orphans) {
  // Guard again at kill time: the listener must survive even if it somehow
  // appeared in this list. Stopping the backend someone is using would be a
  // far worse outcome than leaving an orphan alive.
  if (p.pid === listener) continue;
  try { process.kill(Number(p.pid)); console.log(`    stopped ${p.pid}`); }
  catch { console.log(`    could not stop ${p.pid} (already gone?)`); }
}
console.log(`\n    Done. ${listener ? `:${PORT} was left running.` : ''}\n`);
