/**
 * database-config.test.ts — the production DB guards (audit): fail LOUD on an
 * empty password, a `root` user, or missing TLS in production; stay permissive
 * in dev and for the sqljs test driver.
 */
import { describe, it, expect } from 'vitest';
import { loadDatabaseConfig } from '../src/config/database.config';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
const prodMysql = (o: Record<string, string> = {}) => env({
  NODE_ENV: 'production', DB_ENABLED: 'true', DB_DRIVER: 'mysql',
  DB_USERNAME: 'app', DB_PASSWORD: 'a-real-password', DB_SSL: 'true', ...o,
});

describe('loadDatabaseConfig — production guards (audit)', () => {
  it('DEV: anything goes (empty pw, root, no TLS) — no throw', () => {
    const c = loadDatabaseConfig(env({ DB_ENABLED: 'true', DB_DRIVER: 'mysql' }));
    expect(c.username).toBe('root');
    expect(c.ssl).toBeNull();
  });

  it('sqljs (test driver) is never guarded, even in production', () => {
    expect(() => loadDatabaseConfig(env({ NODE_ENV: 'production', DB_ENABLED: 'true', DB_DRIVER: 'sqljs' })))
      .not.toThrow();
  });

  it('PROD: empty DB_PASSWORD throws', () => {
    expect(() => loadDatabaseConfig(prodMysql({ DB_PASSWORD: '' })))
      .toThrow(/DB_PASSWORD must be set in production/i);
  });

  it('PROD: root username throws', () => {
    expect(() => loadDatabaseConfig(prodMysql({ DB_USERNAME: 'root' })))
      .toThrow(/must not be "root"/i);
  });

  it('PROD: missing TLS throws unless the explicit plaintext opt-out is set', () => {
    expect(() => loadDatabaseConfig(prodMysql({ DB_SSL: 'false' })))
      .toThrow(/DB TLS is required/i);
    // Explicit same-host opt-out is allowed.
    expect(() => loadDatabaseConfig(prodMysql({ DB_SSL: 'false', DB_SSL_ALLOW_PLAINTEXT: 'true' })))
      .not.toThrow();
  });

  it('PROD: a fully-configured connection loads with ssl set', () => {
    const c = loadDatabaseConfig(prodMysql());
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
    expect(c.username).toBe('app');
  });

  it('PROD: DB_SSL_CA is un-escaped and pinned when provided', () => {
    const c = loadDatabaseConfig(prodMysql({ DB_SSL_CA: '-----BEGIN CERT-----\\nABC\\n-----END CERT-----' }));
    expect(c.ssl?.ca).toContain('\n'); // \n literal un-escaped to a real newline
    expect(c.ssl?.ca).not.toContain('\\n');
  });

  it('guards do NOT fire when DB is disabled (AI-only deploy)', () => {
    expect(() => loadDatabaseConfig(env({ NODE_ENV: 'production', DB_ENABLED: 'false', DB_DRIVER: 'mysql' })))
      .not.toThrow();
  });
});
