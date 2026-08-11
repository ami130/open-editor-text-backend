/**
 * migration-sql.test.ts — the migration SQL is EXECUTED, not just written (G1).
 *
 * ─── THE GAP THIS CLOSES ────────────────────────────────────────────────────
 * Every other test builds the schema from TypeORM entity decorators, because
 * sqljs uses `synchronize`. Production does the opposite: MySQL builds its
 * schema from the migration files, and `synchronize` is off.
 *
 * So the delivery tables were proven to work AS ENTITIES and were completely
 * unproven AS SQL. A wrong column type, a missing index, or an
 * INFORMATION_SCHEMA guard that never matches would surface on the first
 * production deploy — against the live database, at the worst possible moment,
 * with nothing earlier able to catch it.
 *
 * ─── WHY IT SKIPS RATHER THAN FAILS WITHOUT MYSQL ───────────────────────────
 * This needs a real MySQL: the migration uses MySQL-only syntax
 * (INFORMATION_SCHEMA, backtick quoting, ON UPDATE CURRENT_TIMESTAMP), which is
 * exactly why sqljs cannot stand in for it. A developer without MySQL should
 * not be blocked, but the skip is LOUD — a silent skip would recreate the very
 * blind spot this file exists to remove.
 *
 * Run it with:
 *   TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:3306/oe_migration_test npx vitest run tests/migration-sql.test.ts
 * CI sets that variable against its MySQL service (see .github/workflows).
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { AddEngineVersions1785433336198 } from '../src/migrations/1785433336198-AddEngineVersions';

const URL = process.env.TEST_MYSQL_URL;
const describeIfMysql = URL ? describe : describe.skip;

if (!URL) {
  // Deliberately noisy: this is the one check that covers production's schema
  // path, so its absence must be visible in the test output rather than
  // silently reported as a pass.
  // eslint-disable-next-line no-console
  console.warn(
    '\n  ⚠️  SKIPPING migration SQL tests — no TEST_MYSQL_URL.\n'
    + '     The delivery migration is UNVERIFIED against real MySQL in this run.\n'
    + '     CI runs these; set TEST_MYSQL_URL to run them locally.\n',
  );
}

let ds: DataSource;

describeIfMysql('delivery migration against REAL MySQL (G1)', () => {
  beforeAll(async () => {
    ds = new DataSource({ type: 'mysql', url: URL, synchronize: false, entities: [] });
    await ds.initialize();
    // Start from a known-empty schema so `up()` is exercised from scratch,
    // exactly as it will be on the first production deploy.
    await ds.query('DROP TABLE IF EXISTS `engine_defaults`');
    await ds.query('DROP TABLE IF EXISTS `engine_versions`');
    for (const col of [
      'pinnedVersion', 'overrideVersion', 'overrideReason', 'overrideReviewAt', 'channel',
    ]) {
      await ds.query(`ALTER TABLE \`licenses\` DROP COLUMN \`${col}\``).catch(() => undefined);
    }
  }, 60_000);

  afterAll(async () => { await ds?.destroy(); });

  it('runs cleanly on an empty schema', async () => {
    const q = ds.createQueryRunner();
    await new AddEngineVersions1785433336198().up(q);
    await q.release();

    const tables = await ds.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('engine_versions','engine_defaults')`,
    );
    expect(tables).toHaveLength(2);
  }, 60_000);

  it('is IDEMPOTENT — running it twice is not an error', async () => {
    // The INFORMATION_SCHEMA guards exist for exactly this. A re-run happens
    // whenever a deploy is retried, and a failure there blocks the deploy.
    const q = ds.createQueryRunner();
    await expect(new AddEngineVersions1785433336198().up(q)).resolves.toBeUndefined();
    await q.release();
  }, 60_000);

  it('creates the columns the ENTITIES expect, with usable types', async () => {
    // The entity/SQL divergence this file exists to catch: a column that is too
    // narrow or the wrong type passes every sqljs test and fails in production.
    // MySQL returns CHARACTER_MAXIMUM_LENGTH as a STRING, not a number —
    // coerced below rather than asserted raw.
    const cols: Array<{ COLUMN_NAME: string; DATA_TYPE: string; CHARACTER_MAXIMUM_LENGTH: unknown }> =
      await ds.query(
        `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'engine_versions'`,
      );
    const by = Object.fromEntries(cols.map((c) => [c.COLUMN_NAME, c]));

    // A SHA-256 hex digest is exactly 64 characters — a narrower column would
    // truncate it and every integrity check would then fail.
    const len = (c?: { CHARACTER_MAXIMUM_LENGTH: unknown }) => Number(c?.CHARACTER_MAXIMUM_LENGTH);
    expect(len(by.bundleSha256)).toBeGreaterThanOrEqual(64);
    // supportedFeatures is a simple-json list; varchar would silently truncate.
    expect(['text', 'longtext', 'mediumtext']).toContain(by.supportedFeatures?.DATA_TYPE);
    expect(len(by.bundleKey)).toBeGreaterThanOrEqual(500);
    for (const c of ['version', 'plan', 'channel', 'status', 'bundleBytes', 'notes']) {
      expect(by[c], `engine_versions.${c} is missing`).toBeTruthy();
    }
  }, 60_000);

  it('enforces the (version, plan) UNIQUE constraint', async () => {
    // Immutability — the basis of rollback and integrity hashing — is enforced
    // in the service AND must be enforced by the schema, or a race writes two.
    const id = () => `t-${Math.random().toString(36).slice(2, 12)}`;
    const insert = () => ds.query(
      'INSERT INTO `engine_versions` '
      + '(`id`,`version`,`plan`,`supportedFeatures`,`bundleKey`,`bundleSha256`) '
      + 'VALUES (?,?,?,?,?,?)',
      [id(), '9.9.9', 'free', '["a"]', 'k', 'a'.repeat(64)],
    );
    await insert();
    await expect(insert()).rejects.toThrow();          // duplicate refused
    await ds.query('DELETE FROM `engine_versions` WHERE `version` = ?', ['9.9.9']);
  }, 60_000);

  it('adds the five delivery columns to `licenses`', async () => {
    const rows: Array<{ COLUMN_NAME: string }> = await ds.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'licenses'`,
    );
    const names = rows.map((r) => r.COLUMN_NAME);
    for (const c of [
      'pinnedVersion', 'overrideVersion', 'overrideReason', 'overrideReviewAt', 'channel',
    ]) {
      expect(names, `licenses.${c} is missing`).toContain(c);
    }
  }, 60_000);

  it('round-trips a real row through the SQL schema', async () => {
    // Proves the columns accept what the application actually writes — the
    // full-length digest and a JSON feature list, not just that they exist.
    const sha = 'b'.repeat(64);
    const features = JSON.stringify(['text.bold', 'export.pdf']);
    await ds.query(
      'INSERT INTO `engine_versions` '
      + '(`id`,`version`,`plan`,`supportedFeatures`,`bundleKey`,`bundleSha256`,`bundleBytes`) '
      + 'VALUES (?,?,?,?,?,?,?)',
      ['rt-1', '8.8.8', 'premium', features, 'engine/8.8.8/premium.js', sha, 657030],
    );
    const [row] = await ds.query(
      'SELECT * FROM `engine_versions` WHERE `id` = ?', ['rt-1'],
    );
    expect(row.bundleSha256).toBe(sha);                 // not truncated
    expect(JSON.parse(row.supportedFeatures)).toEqual(['text.bold', 'export.pdf']);
    expect(row.channel).toBe('internal');               // default applied
    expect(row.status).toBe('published');
    await ds.query('DELETE FROM `engine_versions` WHERE `id` = ?', ['rt-1']);
  }, 60_000);

  it('down() removes what up() added, so a rollback is clean', async () => {
    const q = ds.createQueryRunner();
    await new AddEngineVersions1785433336198().down(q);
    await q.release();

    const tables = await ds.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('engine_versions','engine_defaults')`,
    );
    expect(tables).toHaveLength(0);
  }, 60_000);
});
