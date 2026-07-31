/**
 * database.module.ts — conditionally wires TypeORM/MySQL.
 *
 * Design: the DB is OPTIONAL (see database.config). When DB_ENABLED !== 'true'
 * we register NOTHING, so the app boots and the AI proxy works with no database
 * at all. When enabled, we connect to MySQL. Entities are auto-loaded from
 * feature modules (autoLoadEntities) so licensing entities (Phase C) register
 * themselves without editing this file.
 *
 * `synchronize` is dev-only; production uses migrations (see data-source.ts).
 * `migrationsRun` auto-applies pending migrations on boot — default ON in dev
 * (so a behind DB self-heals), OFF in prod (deliberate deploy step). Both are
 * overridable via env (DB_SYNCHRONIZE / DB_MIGRATIONS_RUN).
 */
import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { loadDatabaseConfig } from '../config/database.config';

@Module({})
export class DatabaseModule {
  static forRoot(): DynamicModule {
    const cfg = loadDatabaseConfig();
    if (!cfg.enabled) {
      // No DB configured → register an empty module. The app runs; licensing
      // features simply aren't available until a DB is configured.
      return { module: DatabaseModule };
    }
    // sqljs: an in-memory pure-JS SQLite — used by tests and quick local dev
    // (DB_DRIVER=sqljs), no server or native build needed. Schema is created
    // via synchronize since there's no migration story for an ephemeral DB.
    const options = cfg.driver === 'sqljs'
      ? { type: 'sqljs' as const, autoSave: false, autoLoadEntities: true, synchronize: true, logging: cfg.logging }
      : {
          type: 'mysql' as const,
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          password: cfg.password,
          database: cfg.database,
          autoLoadEntities: true,
          synchronize: cfg.synchronize,
          // Auto-apply pending migrations on boot when enabled (default: on in
          // dev, off in prod — see database.config). Needs the migrations glob so
          // TypeORM knows what to run; it MUST match src/database/data-source.ts
          // (the CLI DataSource) so app-boot and CLI runs use the same set. Built
          // JS runs from dist, so glob both .ts (ts-node dev) and .js (built).
          migrationsRun: cfg.migrationsRun,
          migrations: [__dirname + '/../migrations/*.{ts,js}'],
          // TLS for data-in-transit when DB_SSL is on (required in prod unless the
          // explicit same-host opt-out is set — see database.config). Omitted when
          // null so a localhost/socket DB connects plaintext as before.
          ...(cfg.ssl ? { ssl: cfg.ssl } : {}),
          logging: cfg.logging,
          retryAttempts: 3,
          retryDelay: 2000,
        };
    return {
      module: DatabaseModule,
      imports: [TypeOrmModule.forRoot(options)],
      exports: [TypeOrmModule],
    };
  }
}
