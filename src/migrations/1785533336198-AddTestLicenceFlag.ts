import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §1.8 — mark a licence as a SANDBOX licence: real entitlements, no commercial
 * meaning.
 *
 * Staging needs licences that grant a full PREMIUM package (so it rehearses the
 * real premium path) while never counting as revenue. `package.isFree` cannot
 * express that — it is a storefront label meaning "this plan costs nothing" and
 * implies priceCents = 0, which is the opposite shape.
 *
 * Without a distinct flag, a licence issued to validate a staging deploy is
 * indistinguishable from a paying customer's: it lands in revenue queries,
 * cannot be swept before a billing reconciliation, and the admin UI cannot warn
 * that it is not a real sale.
 *
 * A SEPARATE migration rather than an edit to AddEngineVersions: that one has
 * already run on real databases, and TypeORM records migrations by name — an
 * edited file would simply never re-run, so the column would silently never
 * exist in production.
 *
 * ADDITIVE + idempotent (INFORMATION_SCHEMA guard, same pattern as its
 * predecessors). Defaults to false, so every existing licence stays a real one.
 */
export class AddTestLicenceFlag1785533336198 implements MigrationInterface {
  name = 'AddTestLicenceFlag1785533336198';

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(q, 'licenses', 'isTest'))) {
      await q.query(
        'ALTER TABLE `licenses` ADD `isTest` tinyint NOT NULL DEFAULT 0',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasColumn(q, 'licenses', 'isTest')) {
      await q.query('ALTER TABLE `licenses` DROP COLUMN `isTest`');
    }
  }
}
