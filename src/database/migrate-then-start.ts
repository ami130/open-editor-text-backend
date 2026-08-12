/**
 * migrate-then-start.ts — the production entrypoint for platforms that give you
 * ONE start command (Railway, Fly, Render).
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `migrationsRun` defaults to OFF in production, deliberately: schema changes
 * should be a reviewed deploy step, not a side effect of a process restarting.
 * That is the right default for a VPS with a separate `migrate` step (see the
 * compose file).
 *
 * But a single-command platform has nowhere to put that step. Without this file
 * the first deploy boots against an EMPTY schema and every request fails on a
 * missing table — and, worse, a later deploy that adds a migration would start
 * serving against a stale schema instead.
 *
 * ─── IT MUST FAIL LOUDLY, NOT LIMP ──────────────────────────────────────────
 * If migrations fail we exit non-zero and DO NOT start the server. A backend
 * serving traffic against a half-migrated schema is worse than one that is
 * plainly down: the platform's health check sees "up", nobody is paged, and
 * customers hit errors that look like application bugs.
 *
 * Exiting non-zero makes the platform mark the deploy failed and keep the
 * PREVIOUS version serving — which is exactly the behaviour we want.
 *
 * ─── SAFE TO RUN ON EVERY BOOT ──────────────────────────────────────────────
 * TypeORM records applied migrations in the `migrations` table and skips them,
 * so a restart or a scale-up re-runs nothing. Concurrent boots are the one
 * sharp edge: two instances starting at once can both attempt the same
 * migration. MySQL DDL is transactional per statement and our migrations are
 * written idempotently (INFORMATION_SCHEMA guards), so the loser fails
 * harmlessly rather than corrupting anything.
 */
import 'reflect-metadata';
// data-source.ts uses a DEFAULT export (verified), not a named one.
import AppDataSource from './data-source';

async function main(): Promise<void> {
  const started = Date.now();
  // eslint-disable-next-line no-console
  console.log('[boot] running migrations…');

  try {
    const ds = await AppDataSource.initialize();
    const applied = await ds.runMigrations({ transaction: 'each' });
    await ds.destroy();

    if (applied.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[boot] schema already up to date (${Date.now() - started}ms)`);
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[boot] applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[boot] MIGRATION FAILED — refusing to start the server.');
    // eslint-disable-next-line no-console
    console.error(err);
    // Non-zero → the platform marks this deploy failed and keeps the previous
    // version serving. Starting anyway would serve traffic against a schema we
    // know is wrong, while the health check reports "up".
    process.exit(1);
  }

  // Hand over to the real application. `import()` rather than a static import
  // so main.ts is not loaded (and does not connect) until migrations are done.
  await import('../main');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[boot] unexpected startup failure:', err);
  process.exit(1);
});
