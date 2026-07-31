/**
 * database.config.ts — typed MySQL/TypeORM configuration from the environment.
 *
 * The database is for the LICENSING/ADMIN side (Phase C+). The AI proxy does
 * NOT need it — so the DB is OPTIONAL: if DB_ENABLED is not "true" (or creds are
 * missing) the app still boots and the AI proxy still works; only the licensing
 * features are unavailable. This keeps the two concerns independent.
 */

export interface DatabaseConfig {
  /** Whether to connect at all. AI-only deployments can leave this off. */
  enabled: boolean;
  /** Driver: 'mysql' (prod default) or 'sqljs' (in-memory, for tests/dev). */
  driver: 'mysql' | 'sqljs';
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /** Auto-sync schema (DEV ONLY — never true in production; use migrations). */
  synchronize: boolean;
  /**
   * Auto-RUN pending migrations on boot. Defaults ON in non-production (so a dev
   * DB that's behind the code self-heals — no more "Unknown column" until you
   * remember `migration:run`), OFF in production (where applying schema changes is
   * a deliberate, reviewed deploy step). Override either way with DB_MIGRATIONS_RUN.
   * Ignored for the sqljs driver (that uses synchronize; it has no migration story).
   */
  migrationsRun: boolean;
  logging: boolean;
  /**
   * TLS for the DB connection (audit — prod DBs on a remote/managed host must
   * encrypt in transit, else credentials + license tokens + customer PII cross
   * the network in cleartext). DB_SSL=true enables it; DB_SSL_CA (optional) pins
   * a CA PEM. null → no TLS (fine for a localhost/socket DB). In production the
   * loader REQUIRES this to be set unless DB_SSL_ALLOW_PLAINTEXT=true (an explicit,
   * documented opt-out for same-host deploys).
   */
  ssl: { rejectUnauthorized: boolean; ca?: string } | null;
}

export const DATABASE_CONFIG = 'DATABASE_CONFIG';

/** Read + normalize DB config from env. Pure; no connection made here. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const enabled = String(env.DB_ENABLED || '').toLowerCase() === 'true';
  const driver = String(env.DB_DRIVER || 'mysql').toLowerCase() === 'sqljs' ? 'sqljs' : 'mysql';
  const isProduction = (env.NODE_ENV || 'development') === 'production';
  const username = env.DB_USERNAME || 'root';
  const password = env.DB_PASSWORD || '';
  const sslOn = parseBoolDefault(env.DB_SSL, false);
  const allowPlaintext = parseBoolDefault(env.DB_SSL_ALLOW_PLAINTEXT, false);

  // Production DB guards — fail LOUD, mirroring the auth/license config guards.
  // Only for a real MySQL connection (sqljs is an in-memory test/dev driver).
  if (isProduction && enabled && driver === 'mysql') {
    if (password.trim() === '') {
      throw new Error('DB_PASSWORD must be set in production (empty DB password is not allowed).');
    }
    if (username === 'root') {
      throw new Error('DB_USERNAME must not be "root" in production — use a least-privilege DB user.');
    }
    if (!sslOn && !allowPlaintext) {
      throw new Error('DB TLS is required in production: set DB_SSL=true (recommended) or DB_SSL_ALLOW_PLAINTEXT=true only for a same-host/socket DB.');
    }
  }

  return {
    enabled,
    driver,
    host: env.DB_HOST || '127.0.0.1',
    port: intOr(env.DB_PORT, 3306),
    username,
    password,
    database: env.DB_DATABASE || 'open_editor',
    ssl: sslOn
      ? { rejectUnauthorized: true, ...(env.DB_SSL_CA ? { ca: env.DB_SSL_CA.replace(/\\n/g, '\n') } : {}) }
      : null,
    // synchronize only when explicitly asked AND not in production.
    synchronize: String(env.DB_SYNCHRONIZE || '').toLowerCase() === 'true'
      && (env.NODE_ENV || 'development') !== 'production',
    // Auto-run migrations: explicit DB_MIGRATIONS_RUN wins; else default ON in
    // non-production, OFF in production (deliberate deploy step there).
    migrationsRun: parseBoolDefault(
      env.DB_MIGRATIONS_RUN,
      (env.NODE_ENV || 'development') !== 'production',
    ),
    logging: String(env.DB_LOGGING || '').toLowerCase() === 'true',
  };
}

function intOr(raw: string | undefined, dflt: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? n : dflt;
}

/** Parse a boolean env var, falling back to `dflt` when unset/blank. Accepts
 *  'true'/'1'/'yes' as true and 'false'/'0'/'no' as false (case-insensitive). */
function parseBoolDefault(raw: string | undefined, dflt: boolean): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return dflt;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return dflt;
}
