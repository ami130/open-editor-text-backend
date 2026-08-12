import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Checkout-time activation (§2.4): `license_activations` + `orders.installId`.
 *
 * WHY: buying premium ends with "check your email, paste the key". The editor
 * the buyer is looking at stays free until they do. An activation lets the
 * running editor upgrade itself: the buyer enters the install id shown in the
 * editor at checkout, and the next session hands that browser its key.
 *
 * The claim is ONE-TIME (`claimedAt`) and EXPIRING (`expiresAt`) because
 * install ids are written to the server logs — a standing "this id gets
 * premium" mapping would turn any log reader into a permanent free customer.
 * See LicenseActivationEntity for the full argument.
 *
 * `claimedAt` is nullable-with-no-default ON PURPOSE: NULL is the load-bearing
 * "unclaimed" state that the conditional UPDATE in `claim()` locks against.
 *
 * ADDITIVE + idempotent, and a SEPARATE file from its predecessors (already run
 * on real databases, recorded by name — an edited one would never re-run).
 */
export class AddLicenseActivations1785723000000 implements MigrationInterface {
  name = 'AddLicenseActivations1785723000000';

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
    if (!(await this.hasTable(q, 'license_activations'))) {
      await q.query(`
        CREATE TABLE \`license_activations\` (
          \`id\` varchar(36) NOT NULL,
          \`installId\` varchar(128) NOT NULL,
          \`licId\` varchar(64) NOT NULL,
          \`claimedAt\` datetime NULL DEFAULT NULL,
          \`claimedFromOrigin\` varchar(255) NOT NULL DEFAULT '',
          \`expiresAt\` datetime NOT NULL,
          \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          UNIQUE INDEX \`IDX_license_activations_install\` (\`installId\`),
          PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB
      `);
    }

    // Carries the buyer's install id from checkout through to fulfilment, which
    // is the only moment the licence id is known.
    if (!(await this.hasColumn(q, 'orders', 'installId'))) {
      await q.query("ALTER TABLE `orders` ADD `installId` varchar(128) NOT NULL DEFAULT ''");
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasColumn(q, 'orders', 'installId')) {
      await q.query('ALTER TABLE `orders` DROP COLUMN `installId`');
    }
    if (await this.hasTable(q, 'license_activations')) {
      await q.query('DROP TABLE `license_activations`');
    }
  }
}
