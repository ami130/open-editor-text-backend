import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Delivery §1.2 — the engine VERSION REGISTRY.
 *
 * One row per (version, plan) pair, so publishing v1.3.0 creates two rows:
 * free and premium. Version, plan, and channel are three INDEPENDENT axes —
 * version is deliberately not tied to plan, or a single customer could never be
 * rolled back without changing what they bought.
 *
 * `supportedFeatures` is the right-hand side of the T14 intersection
 * (granted = package.features ∩ engineVersion.supportedFeatures). It is
 * produced at build time by the engine's scripts/build-manifest.mjs and stored
 * per build, because a licence's own feature snapshot drifts from the engine as
 * soon as either side changes — silently, in both directions.
 *
 * Also adds the delivery columns on `licenses` (pin + admin override), and the
 * per-channel/global defaults table.
 *
 * ADDITIVE + idempotent (INFORMATION_SCHEMA guards, same pattern as the
 * Phase-3/4/5 migrations). Existing rows and behaviour are untouched.
 */
export class AddEngineVersions1785433336198 implements MigrationInterface {
  name = 'AddEngineVersions1785433336198';

  private async hasTable(q: QueryRunner, table: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    // ── engine_versions: one row per (version, plan) ────────────────────────
    if (!(await this.hasTable(q, 'engine_versions'))) {
      await q.query(`
        CREATE TABLE \`engine_versions\` (
          \`id\` varchar(36) NOT NULL,
          \`version\` varchar(32) NOT NULL,
          \`plan\` varchar(16) NOT NULL,
          \`channel\` varchar(16) NOT NULL DEFAULT 'internal',
          \`supportedFeatures\` text NOT NULL,
          \`bundleKey\` varchar(500) NOT NULL,
          \`bundleSha256\` varchar(64) NOT NULL,
          \`bundleBytes\` int NOT NULL DEFAULT 0,
          \`status\` varchar(16) NOT NULL DEFAULT 'published',
          \`notes\` varchar(500) NOT NULL DEFAULT '',
          \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`UQ_engine_version_plan\` (\`version\`, \`plan\`),
          KEY \`IDX_engine_channel_status\` (\`channel\`, \`status\`)
        ) ENGINE=InnoDB
      `);
    }

    // ── engine_defaults: the global + per-channel default pointers ──────────
    // A ROLLBACK is a pointer move here, never an edit to a published bundle —
    // which is why bundles can stay immutable and why rollback takes seconds.
    if (!(await this.hasTable(q, 'engine_defaults'))) {
      await q.query(`
        CREATE TABLE \`engine_defaults\` (
          \`scope\` varchar(32) NOT NULL,
          \`version\` varchar(32) NOT NULL,
          \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`scope\`)
        ) ENGINE=InnoDB
      `);
      // 'global' is the fallback; 'channel:beta' / 'channel:internal' override it.
      await q.query(
        "INSERT INTO `engine_defaults` (`scope`, `version`) VALUES ('global', '') "
        + 'ON DUPLICATE KEY UPDATE `scope` = `scope`',
      );
    }

    // ── licenses: pin + admin override (steps 1 and 2 of the chain) ─────────
    if (!(await this.hasColumn(q, 'licenses', 'pinnedVersion'))) {
      // A customer's explicit pin. ABSOLUTE — no default, promotion, or
      // rollback may move them off it.
      await q.query("ALTER TABLE `licenses` ADD `pinnedVersion` varchar(32) NOT NULL DEFAULT ''");
    }
    if (!(await this.hasColumn(q, 'licenses', 'overrideVersion'))) {
      // Admin "switch this one customer" — e.g. move them back off a bad build.
      await q.query("ALTER TABLE `licenses` ADD `overrideVersion` varchar(32) NOT NULL DEFAULT ''");
    }
    if (!(await this.hasColumn(q, 'licenses', 'overrideReason'))) {
      // Overrides ROT if unexplained: someone is moved back to dodge a bug, then
      // forgotten for two years, quietly missing paid features. Reason + review
      // date are mandatory so an admin view can surface overdue ones.
      await q.query("ALTER TABLE `licenses` ADD `overrideReason` varchar(300) NOT NULL DEFAULT ''");
    }
    if (!(await this.hasColumn(q, 'licenses', 'overrideReviewAt'))) {
      await q.query('ALTER TABLE `licenses` ADD `overrideReviewAt` int NOT NULL DEFAULT 0');
    }
    if (!(await this.hasColumn(q, 'licenses', 'channel'))) {
      // Opt-in release channel. Leaving beta does NOT auto-downgrade (T15):
      // content written by a newer engine may not open in an older one.
      await q.query("ALTER TABLE `licenses` ADD `channel` varchar(16) NOT NULL DEFAULT 'stable'");
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const col of ['channel', 'overrideReviewAt', 'overrideReason', 'overrideVersion', 'pinnedVersion']) {
      if (await this.hasColumn(q, 'licenses', col)) {
        await q.query(`ALTER TABLE \`licenses\` DROP COLUMN \`${col}\``);
      }
    }
    if (await this.hasTable(q, 'engine_defaults')) {
      await q.query('DROP TABLE `engine_defaults`');
    }
    if (await this.hasTable(q, 'engine_versions')) {
      await q.query('DROP TABLE `engine_versions`');
    }
  }
}
