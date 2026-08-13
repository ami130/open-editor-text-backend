import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which package an UNLICENSED visitor receives (Stage 2a).
 *
 * WHY: anonymous sessions resolve to the `'*'` sentinel — "everything this build
 * happens to support" — so what "free" contains is decided by how the bundle was
 * COMPILED, not by anything an admin can change. This makes it data.
 *
 * ONE ROW, FIXED PRIMARY KEY ('anonymous'). A boolean column on `packages`
 * would allow two rows to be true at once, after which "what does a free user
 * get?" depends on row order. A single-row table makes "exactly one" structural.
 *
 * ON DELETE RESTRICT is the R2 guardrail at the database level: the designated
 * package cannot be deleted out from under every anonymous visitor, even by a
 * direct SQL DELETE that bypasses the application.
 *
 * ADDITIVE + idempotent, separate file from its predecessors (already run on
 * real databases and recorded by name).
 */
export class AddDefaultPackage1785740000000 implements MigrationInterface {
  name = 'AddDefaultPackage1785740000000';

  private async hasTable(q: QueryRunner, table: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasTable(q, 'default_packages'))) {
      await q.query(`
        CREATE TABLE \`default_packages\` (
          \`id\` varchar(32) NOT NULL,
          \`packageId\` varchar(36) NOT NULL,
          \`actor\` varchar(128) NOT NULL DEFAULT '',
          \`reason\` varchar(500) NOT NULL DEFAULT '',
          \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`id\`),
          CONSTRAINT \`FK_default_packages_package\` FOREIGN KEY (\`packageId\`)
            REFERENCES \`packages\` (\`id\`) ON DELETE RESTRICT
        ) ENGINE=InnoDB
      `);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasTable(q, 'default_packages')) {
      await q.query('DROP TABLE `default_packages`');
    }
  }
}
