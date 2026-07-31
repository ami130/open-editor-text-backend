import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `group` + `kind` to the `features` table (Phase 3 — unified catalog).
 *
 * This is an ADDITIVE migration (separate from the baseline) so that databases
 * already migrated before Phase 3 receive the new columns — editing the baseline
 * in place would never re-run on those DBs. Idempotent: checks INFORMATION_SCHEMA
 * before adding, so it's safe on a fresh DB, an existing DB, or one that already
 * got the columns from an earlier in-place edit.
 */
export class AddFeatureGroupKind1784733336198 implements MigrationInterface {
  name = 'AddFeatureGroupKind1784733336198';

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(q, 'features', 'group'))) {
      await q.query("ALTER TABLE `features` ADD `group` varchar(60) NOT NULL DEFAULT 'General'");
    }
    if (!(await this.hasColumn(q, 'features', 'kind'))) {
      await q.query("ALTER TABLE `features` ADD `kind` varchar(16) NOT NULL DEFAULT 'premium'");
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasColumn(q, 'features', 'kind')) {
      await q.query('ALTER TABLE `features` DROP COLUMN `kind`');
    }
    if (await this.hasColumn(q, 'features', 'group')) {
      await q.query('ALTER TABLE `features` DROP COLUMN `group`');
    }
  }
}
