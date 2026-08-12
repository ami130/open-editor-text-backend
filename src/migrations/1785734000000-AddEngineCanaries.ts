import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gradual release / canary (§2.7).
 *
 * WHY: today a release goes to 100% of customers at once, so a bad build
 * reaches everyone before anyone notices. A canary contains that blast radius —
 * which the plan rightly calls more valuable than the ability to undo quickly,
 * because rollback only runs after everyone is already broken.
 *
 * ONE ROW PER SCOPE (unique index): "the canary for global" is a single fact,
 * and layering two partial rollouts would be impossible to reason about.
 *
 * ADDITIVE + idempotent; separate file from its predecessors (already run on
 * real databases and recorded by name).
 */
export class AddEngineCanaries1785734000000 implements MigrationInterface {
  name = 'AddEngineCanaries1785734000000';

  private async hasTable(q: QueryRunner, table: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasTable(q, 'engine_canaries'))) {
      await q.query(`
        CREATE TABLE \`engine_canaries\` (
          \`id\` varchar(36) NOT NULL,
          \`scope\` varchar(32) NOT NULL,
          \`version\` varchar(32) NOT NULL,
          \`percent\` int NOT NULL DEFAULT 0,
          \`actor\` varchar(128) NOT NULL DEFAULT '',
          \`reason\` varchar(500) NOT NULL DEFAULT '',
          \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          \`updatedAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          UNIQUE INDEX \`IDX_engine_canaries_scope\` (\`scope\`),
          PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB
      `);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasTable(q, 'engine_canaries')) {
      await q.query('DROP TABLE `engine_canaries`');
    }
  }
}
