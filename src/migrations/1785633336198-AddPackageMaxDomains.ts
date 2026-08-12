import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cap how many domains one licence may bind (§2 security).
 *
 * `domainBound` already says a licence must NAME its domains, but says nothing
 * about how many. Without a cap, one payment could legitimately list fifty
 * sites — so "one payment, one place" was a convention rather than a rule, with
 * nothing enforcing it at the moment a licence is issued.
 *
 * DEFAULTS TO 0 = UNLIMITED, deliberately. Every existing package and licence
 * keeps working exactly as before; a cap is opt-in per package. A migration
 * that silently tightened an existing customer's terms mid-term would be the
 * wrong kind of security — it would break payers, not stop sharers.
 *
 * A SEPARATE migration rather than an edit to an earlier one: those have
 * already run on real databases, and TypeORM records migrations by name, so an
 * edited file would never re-run and the column would silently never exist in
 * production.
 *
 * ADDITIVE + idempotent (INFORMATION_SCHEMA guard, same pattern as its
 * predecessors).
 */
export class AddPackageMaxDomains1785633336198 implements MigrationInterface {
  name = 'AddPackageMaxDomains1785633336198';

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(q, 'packages', 'maxDomains'))) {
      await q.query('ALTER TABLE `packages` ADD `maxDomains` int NOT NULL DEFAULT 0');
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasColumn(q, 'packages', 'maxDomains')) {
      await q.query('ALTER TABLE `packages` DROP COLUMN `maxDomains`');
    }
  }
}
