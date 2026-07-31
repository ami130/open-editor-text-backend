import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Audit B2 — expiry-reminder idempotency column on `licenses`:
 *   reminderSentAt (int) — unix seconds the "your access is ending soon" email was
 *                          sent for the CURRENT term, else 0. Set inline on refresh
 *                          when a finite-term token nears renewUntil; reset to 0 by
 *                          admin `renew` (a new term earns a fresh reminder). Ensures
 *                          the reminder fires exactly once per term, not on every
 *                          near-expiry refresh. Lifetime licenses are perpetual
 *                          (renewUntil = -1) so they never trip this path.
 * ADDITIVE + idempotent (INFORMATION_SCHEMA column guard, same pattern as the
 * Phase-3/4/5 migrations).
 */
export class AddLicenseReminderSentAt1785333336198 implements MigrationInterface {
  name = 'AddLicenseReminderSentAt1785333336198';

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(q, 'licenses', 'reminderSentAt'))) {
      await q.query('ALTER TABLE `licenses` ADD `reminderSentAt` int NOT NULL DEFAULT 0');
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasColumn(q, 'licenses', 'reminderSentAt')) {
      await q.query('ALTER TABLE `licenses` DROP COLUMN `reminderSentAt`');
    }
  }
}
