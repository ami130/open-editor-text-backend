import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds Phase 3 columns:
 *   packages.isFree             — storefront "free" label (coherence enforced server-side)
 *   packages.refreshPolicy      — derived from billingInterval; consumed by Phase 4
 *   packages.ttlOverrideSeconds — nullable explicit-TTL escape hatch (plan §7 option B)
 *   orders.billingInterval      — checkout snapshot of the sold interval
 *   orders.refreshPolicy        — checkout snapshot of the refresh policy
 *
 * ADDITIVE + idempotent (mirrors AddFeatureGroupKind): checks INFORMATION_SCHEMA
 * before each ALTER, so it is safe on a fresh DB, an already-migrated DB, or one
 * that somehow already has a column. Prod is migrations-only (synchronize:false);
 * tests use sqljs synchronize:true and pick the columns up from the entities.
 *
 * BACKFILL: the new refreshPolicy columns default to 'manual', but rows created
 * BEFORE Phase 3 carry a real billingInterval — a monthly/yearly/lifetime package
 * must be 'auto', not the default. So each freshly-added refreshPolicy is
 * backfilled from the row's own billingInterval to match durationPolicy() (else a
 * pre-existing subscription would read 'manual' and never auto-renew in Phase 4).
 * The backfill runs ONLY when the column was just added, so a re-run on a DB that
 * already has the column never clobbers admin edits made since.
 */
export class AddPackageDurationAndIsFree1784833336198 implements MigrationInterface {
  name = 'AddPackageDurationAndIsFree1784833336198';

  private async hasColumn(q: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(q, 'packages', 'isFree'))) {
      await q.query('ALTER TABLE `packages` ADD `isFree` tinyint NOT NULL DEFAULT 0');
    }
    if (!(await this.hasColumn(q, 'packages', 'refreshPolicy'))) {
      await q.query("ALTER TABLE `packages` ADD `refreshPolicy` varchar(8) NOT NULL DEFAULT 'manual'");
      // Backfill from each package's existing interval (auto for recurring/lifetime).
      await q.query(
        "UPDATE `packages` SET `refreshPolicy` = 'auto' WHERE `billingInterval` IN ('monthly', 'yearly', 'lifetime')",
      );
    }
    if (!(await this.hasColumn(q, 'packages', 'ttlOverrideSeconds'))) {
      await q.query('ALTER TABLE `packages` ADD `ttlOverrideSeconds` int NULL');
    }
    if (!(await this.hasColumn(q, 'orders', 'billingInterval'))) {
      await q.query("ALTER TABLE `orders` ADD `billingInterval` varchar(16) NOT NULL DEFAULT 'once'");
      // Backfill the interval snapshot from the still-linked package where possible
      // (orders whose package was deleted keep the 'once' default — best effort).
      await q.query(
        'UPDATE `orders` o JOIN `packages` p ON o.`packageId` = p.`id` ' +
          'SET o.`billingInterval` = p.`billingInterval`',
      );
    }
    if (!(await this.hasColumn(q, 'orders', 'refreshPolicy'))) {
      await q.query("ALTER TABLE `orders` ADD `refreshPolicy` varchar(8) NOT NULL DEFAULT 'manual'");
      await q.query(
        'UPDATE `orders` o JOIN `packages` p ON o.`packageId` = p.`id` ' +
          'SET o.`refreshPolicy` = p.`refreshPolicy`',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasColumn(q, 'orders', 'refreshPolicy')) {
      await q.query('ALTER TABLE `orders` DROP COLUMN `refreshPolicy`');
    }
    if (await this.hasColumn(q, 'orders', 'billingInterval')) {
      await q.query('ALTER TABLE `orders` DROP COLUMN `billingInterval`');
    }
    if (await this.hasColumn(q, 'packages', 'ttlOverrideSeconds')) {
      await q.query('ALTER TABLE `packages` DROP COLUMN `ttlOverrideSeconds`');
    }
    if (await this.hasColumn(q, 'packages', 'refreshPolicy')) {
      await q.query('ALTER TABLE `packages` DROP COLUMN `refreshPolicy`');
    }
    if (await this.hasColumn(q, 'packages', 'isFree')) {
      await q.query('ALTER TABLE `packages` DROP COLUMN `isFree`');
    }
  }
}
