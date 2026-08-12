import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Release/rollback history for engine default pointers (§2.8).
 *
 * WHY: `engine_defaults` holds only the CURRENT pointer, which is the wrong
 * shape during an incident — rolling back requires naming the last-known-good
 * version, and that value has already been overwritten. Without history,
 * "roll back" means guessing a version number under pressure while every
 * customer is affected simultaneously.
 *
 * Append-only, so it doubles as the audit trail for "who changed what every
 * customer receives". Volume is a row per deliberate release, not per request.
 *
 * ADDITIVE + idempotent, separate file from its predecessors (already run on
 * real databases and recorded by name — an edited one would never re-run).
 */
export class AddEngineDefaultHistory1785730000000 implements MigrationInterface {
  name = 'AddEngineDefaultHistory1785730000000';

  private async hasTable(q: QueryRunner, table: string): Promise<boolean> {
    const rows: Array<{ c: number }> = await q.query(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return Number(rows[0]?.c || 0) > 0;
  }

  public async up(q: QueryRunner): Promise<void> {
    if (!(await this.hasTable(q, 'engine_default_history'))) {
      await q.query(`
        CREATE TABLE \`engine_default_history\` (
          \`id\` varchar(36) NOT NULL,
          \`scope\` varchar(32) NOT NULL,
          \`fromVersion\` varchar(32) NOT NULL DEFAULT '',
          \`toVersion\` varchar(32) NOT NULL,
          \`kind\` varchar(16) NOT NULL DEFAULT 'release',
          \`actor\` varchar(128) NOT NULL DEFAULT '',
          \`reason\` varchar(500) NOT NULL DEFAULT '',
          \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          INDEX \`IDX_engine_default_history_scope_time\` (\`scope\`, \`createdAt\`),
          PRIMARY KEY (\`id\`)
        ) ENGINE=InnoDB
      `);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await this.hasTable(q, 'engine_default_history')) {
      await q.query('DROP TABLE `engine_default_history`');
    }
  }
}
