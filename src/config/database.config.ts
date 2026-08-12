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

/**
 * Parse a single connection URL (`mysql://user:pass@host:port/dbname`).
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Managed platforms (Railway, Render, Fly, Heroku) hand you ONE variable
 * containing the whole connection, and expect you to consume it. Requiring five
 * separate variables instead means five chances to mistype a name — and a
 * missing one does not error, it silently falls back to `127.0.0.1`, which
 * looks exactly like "the database is down".
 *
 * That is not hypothetical: it cost a full deploy cycle to diagnose, because
 * `ECONNREFUSED 127.0.0.1:3306` reads like a network fault rather than an unset
 * variable.
 *
 * Returns null for anything unparseable, so a malformed URL degrades to the
 * individual DB_* variables rather than throwing during config load.
 */
function parseConnectionUrl(raw: string | undefined): {
  host: string; port: number; username: string; password: string; database: string;
} | null {
  const value = (raw || '').trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    if (!/^mysql:?$/i.test(u.protocol.replace(':', ''))) return null;
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!u.hostname || !database) return null;
    return {
      host: u.hostname,
      port: Number(u.port) || 3306,
      // URL-encoded credentials are normal — a password with '@' or '/' must
      // round-trip correctly or authentication fails with a confusing error.
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      database,
    };
  } catch {
    return null;
  }
}

/**
 * Is this host a platform-managed, private-network database?
 *
 * Railway/Render/Fly expose managed MySQL on an INTERNAL hostname reachable
 * only from inside your own project's network, and hand out `root` because
 * there is no other user. Refusing root there blocks a deployment over a rule
 * that cannot be satisfied — while the actual risk the rule guards against
 * (a root credential exposed to the internet) does not apply.
 */
function isPlatformInternalHost(host: string): boolean {
  const h = (host || '').toLowerCase();
  return h.endsWith('.railway.internal')
    || h.endsWith('.internal')
    || h.endsWith('.flycast')
    || h.endsWith('.render.com')
    // Railway's PUBLIC TCP proxy. Not a private network, but still a
    // platform-managed database whose only user is root — the operator has no
    // way to comply with the rule, so refusing merely blocks them. TLS is NOT
    // waived for these (that check is separate and still applies), so the
    // connection is still required to be encrypted or explicitly opted out of.
    || h.endsWith('.proxy.rlwy.net')
    || h.endsWith('.railway.app');
}

/** Read + normalize DB config from env. Pure; no connection made here. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const enabled = String(env.DB_ENABLED || '').toLowerCase() === 'true';
  const driver = String(env.DB_DRIVER || 'mysql').toLowerCase() === 'sqljs' ? 'sqljs' : 'mysql';
  const isProduction = (env.NODE_ENV || 'development') === 'production';

  // A connection URL, when present, supplies every field — but each individual
  // DB_* variable still WINS over it, so an operator can override one piece
  // (e.g. point at a replica host) without rewriting the whole URL.
  const url = parseConnectionUrl(env.DATABASE_URL || env.MYSQL_URL || env.DB_URL);

  const username = env.DB_USERNAME || url?.username || 'root';
  const password = env.DB_PASSWORD || url?.password || '';
  const sslOn = parseBoolDefault(env.DB_SSL, false);
  const allowPlaintext = parseBoolDefault(env.DB_SSL_ALLOW_PLAINTEXT, false);

  // Production DB guards — fail LOUD, mirroring the auth/license config guards.
  // Only for a real MySQL connection (sqljs is an in-memory test/dev driver).
  if (isProduction && enabled && driver === 'mysql') {
    if (password.trim() === '') {
      throw new Error('DB_PASSWORD must be set in production (empty DB password is not allowed).');
    }
    /**
     * Root is refused in production, with two escapes:
     *
     *   1. a platform-managed PRIVATE host (see isPlatformInternalHost) — the
     *      risk this rule guards against, a root credential reachable from the
     *      internet, does not exist there; and
     *   2. an EXPLICIT opt-out, DB_ALLOW_ROOT=true.
     *
     * (2) exists because managed platforms frequently provide ONLY a root user.
     * Railway's MySQL does. Without an escape hatch the rule is not a guard, it
     * is a wall: the operator cannot comply no matter what they do, and their
     * only remaining option is to stop using the product.
     *
     * Note this mirrors DB_SSL_ALLOW_PLAINTEXT, which already exists for
     * exactly the same reason. Shipping one rule with an opt-out and the other
     * without was an inconsistency on my part, found when a real deploy hit it.
     *
     * Deliberately opt-IN and named plainly, so it appears in a config review
     * and cannot be set by accident.
     */
    const allowRoot = parseBoolDefault(env.DB_ALLOW_ROOT, false);
    if (username === 'root'
      && !allowRoot
      && !isPlatformInternalHost(env.DB_HOST || url?.host || '')) {
      throw new Error(
        'DB_USERNAME must not be "root" in production — use a least-privilege DB user. '
        + 'Allowed automatically on a platform-managed private host (e.g. *.railway.internal); '
        + 'otherwise set DB_ALLOW_ROOT=true to accept the risk explicitly.',
      );
    }
    // TLS is required in production — EXCEPT on a platform-managed private
    // host. Railway/Render/Fly terminate their managed database on an internal
    // network that is not routable from outside the project, and their MySQL
    // does not offer TLS on it. Demanding TLS there blocks the deployment over
    // a rule that cannot be satisfied, while the risk it guards against
    // (credentials crossing a public network in plaintext) does not apply.
    //
    // Any OTHER host still requires TLS or an explicit opt-out.
    const dbHost = (env.DB_HOST || url?.host || '').toLowerCase();
    // ⚠️ PRIVATE hosts only — deliberately NOT isPlatformInternalHost(), which
    // now also matches Railway's PUBLIC proxy. Traffic to a public proxy really
    // does cross the internet, so plaintext there must stay an explicit,
    // reviewed decision (DB_SSL_ALLOW_PLAINTEXT) rather than a silent default.
    const privateHost = dbHost.endsWith('.railway.internal')
      || dbHost.endsWith('.internal')
      || dbHost.endsWith('.flycast');
    if (!sslOn && !allowPlaintext && !privateHost) {
      throw new Error('DB TLS is required in production: set DB_SSL=true (recommended) or DB_SSL_ALLOW_PLAINTEXT=true only for a same-host/socket DB.');
    }
  }

  return {
    enabled,
    driver,
    host: env.DB_HOST || url?.host || '127.0.0.1',
    port: env.DB_PORT ? intOr(env.DB_PORT, 3306) : (url?.port ?? 3306),
    username,
    password,
    database: env.DB_DATABASE || url?.database || 'open_editor',
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
