import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5c — anti-sharing SOFT FLAG columns on `licenses`:
 *   flaggedAt  (int)          — unix seconds the sharing detector tripped, else 0.
 *   flagReason (varchar 200)  — human-readable reason, empty when unflagged.
 * A flagged license KEEPS WORKING (separate from `status`); the flag is a signal
 * for an admin to review + optionally revoke. ADDITIVE + idempotent
 * (INFORMATION_SCHEMA column guard, same pattern as the Phase-3/4 migrations).
 */
export class AddLicenseFlag1785233336198 implements MigrationInterface {
  name = 'AddLicenseFlag1785233336198';

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(q, 'licenses', 'flaggedAt'))) {
      await q.query('ALTER TABLE `licenses` ADD `flaggedAt` int NOT NULL DEFAULT 0');
    }
    if (!(await this.hasColumn(q, 'licenses', 'flagReason'))) {
      await q.query("ALTER TABLE `licenses` ADD `flagReason` varchar(200) NOT NULL DEFAULT ''");
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasColumn(q, 'licenses', 'flagReason')) {
      await q.query('ALTER TABLE `licenses` DROP COLUMN `flagReason`');
    }
    if (await this.hasColumn(q, 'licenses', 'flaggedAt')) {
      await q.query('ALTER TABLE `licenses` DROP COLUMN `flaggedAt`');
    }
  }
}
