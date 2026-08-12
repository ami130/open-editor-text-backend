import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Install-ID cap (§2.4): `packages.maxInstalls` + the `license_installs` table.
 *
 * WHY: domain binding exempts `localhost` so developers can build without
 * owning the customer's domain. That exemption has no ceiling — one key shared
 * in a group chat works on unlimited local machines and the domain gate never
 * fires. Counting distinct installs per licence closes it.
 *
 * DEFAULTS TO 0 = UNLIMITED. Every existing package keeps its exact current
 * behaviour and the feature stays inert until a plan opts in. A migration that
 * silently capped live customers would break payers, not stop sharers.
 *
 * The UNIQUE index on (licId, installId) is load-bearing, not an optimisation:
 * it makes "seen this install before?" one indexed lookup AND makes a duplicate
 * seat impossible when two tabs open a session at the same moment.
 *
 * ADDITIVE + idempotent (INFORMATION_SCHEMA guards), same pattern as its
 * predecessors, and a SEPARATE file because earlier migrations have already run
 * on real databases and are recorded by name — an edited one would never re-run.
 */
export class AddInstallCap1785719400000 implements MigrationInterface {
  name = 'AddInstallCap1785719400000';

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  private async hasTable(q: QueryRunner, table: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(q, 'packages', 'maxInstalls'))) {
      await q.query('ALTER TABLE `packages` ADD `maxInstalls` int NOT NULL DEFAULT 0');
    }

    if (!(await this.hasTable(q, 'license_installs'))) {
      await q.query(`
        CREATE TABLE \`license_installs\` (
          \`id\` varchar(36) NOT NULL,
          \`licId\` varchar(64) NOT NULL,
          \`installId\` varchar(128) NOT NULL,
          \`origin\` varchar(255) NOT NULL DEFAULT '',
          \`blocked\` tinyint NOT NULL DEFAULT 0,
          \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          \`lastSeenAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          UNIQUE INDEX \`IDX_license_installs_lic_install\` (\`licId\`, \`installId\`),
          PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB
      `);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasTable(q, 'license_installs')) {
      await q.query('DROP TABLE `license_installs`');
    }
    if (await this.hasColumn(q, 'packages', 'maxInstalls')) {
      await q.query('ALTER TABLE `packages` DROP COLUMN `maxInstalls`');
    }
  }
}
