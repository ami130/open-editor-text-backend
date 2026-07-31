/**
 * data-source.ts — a standalone TypeORM DataSource for the migration CLI.
 *
 * The runtime uses DatabaseModule (NestJS DI); the TypeORM CLI needs its own
 * DataSource to generate/run migrations. Both read the same env config so they
 * never drift. Entities/migrations are globbed from the build/src tree.
 *
 * Usage (examples; wired as npm scripts):
 *   typeorm migration:generate -d dist/database/data-source.js src/migrations/<Name>
 *   typeorm migration:run      -d dist/database/data-source.js
 */
import 'reflect-metadata';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { loadDatabaseConfig } from '../config/database.config';

// The Nest app loads .env via @nestjs/config (see app.module.ts); this
// standalone CLI entrypoint does not go through Nest, so it must load .env
// itself or every `npm run migration:*` silently ignores .env and falls back
// to database.config.ts's defaults (e.g. DB_DATABASE='open_editor'), even when
// the developer's .env says otherwise.
//
// dotenv.config() never overrides a key already in process.env, so real
// environment variables (e.g. the prod `migrate` container's compose
// `environment:` block) always win over anything in .env. Wrapped in try/catch
// + require (not a static import) because dotenv is only a transitive
// dependency (via @nestjs/config) — if it's ever absent (e.g. a pruned prod
// image), this must degrade to "no .env loaded", not crash the CLI.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config({ path: resolve(__dirname, '../../.env') });
} catch {
  // no dotenv / no .env file — fall through to ambient process.env only.
}

const cfg = loadDatabaseConfig();

export default new DataSource({
  type: 'mysql',
  host: cfg.host,
  port: cfg.port,
  username: cfg.username,
  password: cfg.password,
  database: cfg.database,
  // Migrations are authored against the compiled output; entities are picked up
  // per-feature as licensing modules are added.
  entities: [__dirname + '/../**/*.entity.{ts,js}'],
  migrations: [__dirname + '/../migrations/*.{ts,js}'],
  synchronize: false, // migrations only — never auto-sync from the CLI
  logging: cfg.logging,
});
