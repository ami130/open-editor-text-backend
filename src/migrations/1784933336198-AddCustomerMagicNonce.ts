import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `customers.magicNonce` — the single-use nonce for the Phase-4 self-serve
 * portal magic-link (rotated on issue + consume). ADDITIVE + idempotent (mirrors
 * the AddFeatureGroupKind / AddPackageDurationAndIsFree pattern): checks
 * INFORMATION_SCHEMA before the ALTER. Prod is migrations-only; tests use sqljs
 * synchronize and pick the column up from the entity.
 */
export class AddCustomerMagicNonce1784933336198 implements MigrationInterface {
  name = 'AddCustomerMagicNonce1784933336198';

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(q, 'customers', 'magicNonce'))) {
      await q.query("ALTER TABLE `customers` ADD `magicNonce` varchar(64) NOT NULL DEFAULT ''");
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasColumn(q, 'customers', 'magicNonce')) {
      await q.query('ALTER TABLE `customers` DROP COLUMN `magicNonce`');
    }
  }
}
