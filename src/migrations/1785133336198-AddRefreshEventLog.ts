import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5b — the persisted refresh fetch-log (`refresh_events`), the queryable
 * store the anti-sharing detector reads. Idempotent via `CREATE TABLE IF NOT
 * EXISTS` (a NEW TABLE, unlike the additive-column migrations before it). Mirrors
 * the InitialSchema table shape (InnoDB, datetime(6) default) and the entity's
 * composite (licId, createdAt) index for the detector's hot query.
 */
export class AddRefreshEventLog1785133336198 implements MigrationInterface {
  name = 'AddRefreshEventLog1785133336198';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS \`refresh_events\` (
      \`id\` varchar(36) NOT NULL,
      \`licId\` varchar(64) NOT NULL DEFAULT '',
      \`ip\` varchar(64) NOT NULL DEFAULT '',
      \`origin\` varchar(255) NOT NULL DEFAULT '',
      \`outcome\` varchar(16) NOT NULL DEFAULT '',
      \`createdAt\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (\`id\`),
      INDEX \`IDX_refresh_events_lic_created\` (\`licId\`, \`createdAt\`),
      INDEX \`IDX_refresh_events_created\` (\`createdAt\`)
    ) ENGINE=InnoDB`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS `refresh_events`');
  }
}
