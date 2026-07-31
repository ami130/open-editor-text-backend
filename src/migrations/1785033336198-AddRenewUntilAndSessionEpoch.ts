import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4c hardening (audit fixes):
 *   licenses.renewUntil   — paid-term boundary; refresh re-mints only while
 *                           now < renewUntil (C1: stops renew-forever). Default 0
 *                           = legacy row → the refresh service DERIVES the bound
 *                           from createdAt + package interval, so old licenses are
 *                           bounded without a fragile SQL backfill.
 *   customers.sessionEpoch — portal session revocation handle (M4): bumped on
 *                           logout/revoke to kill all outstanding sessions.
 *
 * ADDITIVE + idempotent (same pattern as the other Phase-3/4 migrations).
 */
export class AddRenewUntilAndSessionEpoch1785033336198 implements MigrationInterface {
  name = 'AddRenewUntilAndSessionEpoch1785033336198';

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(q, 'licenses', 'renewUntil'))) {
      await q.query('ALTER TABLE `licenses` ADD `renewUntil` int NOT NULL DEFAULT 0');
    }
    if (!(await this.hasColumn(q, 'customers', 'sessionEpoch'))) {
      await q.query('ALTER TABLE `customers` ADD `sessionEpoch` int NOT NULL DEFAULT 0');
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasColumn(q, 'customers', 'sessionEpoch')) {
      await q.query('ALTER TABLE `customers` DROP COLUMN `sessionEpoch`');
    }
    if (await this.hasColumn(q, 'licenses', 'renewUntil')) {
      await q.query('ALTER TABLE `licenses` DROP COLUMN `renewUntil`');
    }
  }
}
