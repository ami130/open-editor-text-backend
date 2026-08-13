/**
 * health.e2e.test.ts — proves the Phase B foundation guarantees:
 *   • the app BOOTS with NO database configured (AI + licensing are decoupled),
 *   • GET /health reports each subsystem honestly (db disabled, ai status),
 *   • overall status is "ok" when the DB is merely disabled (not a failure).
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  // Ensure DB is OFF for this suite (the default, but be explicit).
  delete process.env.DB_ENABLED;
  delete process.env.GROQ_API_KEY;
  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = mod.createNestApplication({ logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => { await app.close(); });

describe('GET /health (no DB, no AI key)', () => {
  it('boots and returns a structured health report', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.service).toBe('open-editor-backend');
    expect(typeof body.timestamp).toBe('string');
  });

  it('reports the database as "disabled" (not a failure) → overall ok', async () => {
    const body = await (await fetch(`${base}/health`)).json();
    expect(body.checks.database.status).toBe('disabled');
    expect(body.status).toBe('ok');
  });

  it('reports the AI subsystem as not-configured when no key is set', async () => {
    const body = await (await fetch(`${base}/health`)).json();
    expect(body.checks.ai.status).toBe('not-configured');
  });

  it('reports WHICH mail transport is configured — the gap that cost a real diagnosis', async () => {
    // A licence email silently did not arrive in production and there was no
    // way to distinguish "no transport configured" (sends are dropped, returns
    // success) from "transport configured but failing" (returns failure). The
    // two look identical from outside and have completely different fixes.
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(body.checks.email).toBeDefined();
    expect(['configured', 'not-configured']).toContain(body.checks.email.status);
    expect(['smtp', 'webhook', 'none']).toContain(body.checks.email.transport);
  });

  it('a missing mail transport does NOT make the service look degraded', async () => {
    // Fulfilment succeeds without email and the key stays retrievable, so
    // losing mail costs a convenience, not the product. Reporting 'degraded'
    // would page someone for something that is not an outage.
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    if (body.checks.email.status === 'not-configured') {
      expect(body.status).not.toBe('degraded');
    }
  });

  it('health never leaks the mail host or credentials', async () => {
    // This endpoint is public-ish; it must not become a way to probe someone's
    // mail setup.
    const res = await fetch(`${base}/health`);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toMatch(/smtp\.|@|password|pass"|user"/i);
  });

  it('the AI proxy still exists even with no DB (subsystems are decoupled)', async () => {
    // /api/ai/health is the proxy's own probe; it must respond regardless of DB.
    const r = await fetch(`${base}/api/ai/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });
});
