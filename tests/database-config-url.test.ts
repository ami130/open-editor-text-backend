/**
 * Connection-URL support + the scoped root exemption.
 *
 * Motivated by a real deploy failure: five separate DB_* variables meant five
 * chances to mistype a name, and a missing one does not error — it silently
 * falls back to 127.0.0.1, which reads like "the database is down" rather than
 * "a variable is unset".
 */
import { describe, it, expect } from 'vitest';
import { loadDatabaseConfig } from '../src/config/database.config';

const base = {
  DB_ENABLED: 'true',
  DB_DRIVER: 'mysql',
  NODE_ENV: 'production',
} as NodeJS.ProcessEnv;

describe('database config — connection URL', () => {
  it('parses every field from a single MYSQL_URL', () => {
    const cfg = loadDatabaseConfig({
      ...base,
      MYSQL_URL: 'mysql://appuser:s3cret@mysql.railway.internal:3306/railway',
    });
    expect(cfg.host).toBe('mysql.railway.internal');
    expect(cfg.port).toBe(3306);
    expect(cfg.username).toBe('appuser');
    expect(cfg.password).toBe('s3cret');
    expect(cfg.database).toBe('railway');
  });

  it('accepts DATABASE_URL and DB_URL too (platforms differ)', () => {
    for (const key of ['DATABASE_URL', 'DB_URL']) {
      const cfg = loadDatabaseConfig({
        ...base, [key]: 'mysql://u:p@db.internal:3307/mydb',
      } as NodeJS.ProcessEnv);
      expect(cfg.host).toBe('db.internal');
      expect(cfg.port).toBe(3307);
    }
  });

  it('URL-DECODES credentials — a password with @ or / must round-trip', () => {
    // Otherwise auth fails with a confusing "access denied" that looks like a
    // wrong password rather than a parsing bug.
    const cfg = loadDatabaseConfig({
      ...base,
      MYSQL_URL: `mysql://user:${encodeURIComponent('p@ss/w0rd')}@db.internal:3306/app`,
    });
    expect(cfg.password).toBe('p@ss/w0rd');
  });

  it('individual DB_* variables OVERRIDE the URL', () => {
    // So an operator can repoint one field (e.g. a replica host) without
    // rewriting the whole connection string.
    const cfg = loadDatabaseConfig({
      ...base,
      MYSQL_URL: 'mysql://u:p@old.internal:3306/olddb',
      DB_HOST: 'new.internal',
      DB_DATABASE: 'newdb',
    });
    expect(cfg.host).toBe('new.internal');
    expect(cfg.database).toBe('newdb');
    expect(cfg.username).toBe('u');   // untouched fields still come from the URL
  });

  it('a malformed URL degrades to DB_* rather than throwing', () => {
    const cfg = loadDatabaseConfig({
      ...base,
      MYSQL_URL: 'not-a-url',
      DB_HOST: 'fallback.internal',
      DB_USERNAME: 'appuser',
      DB_PASSWORD: 'pw',
      DB_SSL_ALLOW_PLAINTEXT: 'true',
    });
    expect(cfg.host).toBe('fallback.internal');
  });

  it('a non-mysql URL is ignored (postgres must not be silently accepted)', () => {
    const cfg = loadDatabaseConfig({
      ...base,
      MYSQL_URL: 'postgres://u:p@pg.internal:5432/app',
      DB_HOST: 'real.internal', DB_USERNAME: 'appuser', DB_PASSWORD: 'pw',
      DB_SSL_ALLOW_PLAINTEXT: 'true',
    });
    expect(cfg.host).toBe('real.internal');
  });
});

describe('database config — the root rule', () => {
  it('ALLOWS root on a platform-managed private host', () => {
    // Railway's managed MySQL provides only root, on an internal hostname
    // reachable solely from inside the project's own network.
    const cfg = loadDatabaseConfig({
      ...base,
      MYSQL_URL: 'mysql://root:pw@mysql.railway.internal:3306/railway',
      DB_SSL_ALLOW_PLAINTEXT: 'true',
    });
    expect(cfg.username).toBe('root');
  });

  it('STILL REFUSES root on a public host — the exemption must not widen', () => {
    // This is the security boundary. Root on a reachable host is exactly what
    // the original rule exists to prevent.
    expect(() => loadDatabaseConfig({
      ...base,
      DB_HOST: 'db.example.com',
      DB_USERNAME: 'root',
      DB_PASSWORD: 'pw',
      DB_SSL_ALLOW_PLAINTEXT: 'true',
    })).toThrow(/must not be "root"/i);
  });

  it('STILL REQUIRES TLS on a public host — the exemption must not widen', () => {
    // Same boundary as the root rule: relaxing TLS for an internal platform
    // host must not relax it for a database reachable over the internet.
    expect(() => loadDatabaseConfig({
      ...base,
      DB_HOST: 'db.example.com',
      DB_USERNAME: 'appuser',
      DB_PASSWORD: 'pw',
    })).toThrow(/TLS is required/i);
  });

  it('still refuses an empty password in production', () => {
    expect(() => loadDatabaseConfig({
      ...base,
      MYSQL_URL: 'mysql://root:@mysql.railway.internal:3306/railway',
    })).toThrow(/DB_PASSWORD must be set/i);
  });
});
