/**
 * ai.e2e.test.ts — boots the REAL Nest app over HTTP and drives POST /api/ai,
 * proving the controller wiring: JSON body parsing, 400 validation, streaming
 * the provider reply back, and that the API key never reaches the browser.
 *
 * The upstream provider is faked at the AiService boundary (Nest overrideProvider)
 * rather than by stubbing global fetch — that keeps the test's own HTTP calls to
 * the local server real, and avoids undici/fetch-interception flakiness.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { AiService } from '../src/ai/ai.service';

const SECRET = 'super-secret-key-123';

// A fake AiService: real validate() (so 400s still work), but stream() returns
// a canned OpenAI-shaped SSE Response instead of calling a provider.
class FakeAiService extends AiService {
  constructor() { super({ apiKey: SECRET, baseUrl: 'x', model: 'm', enabled: true, maxPromptChars: 24000, corsOrigins: [], timeoutMs: 30000 }); }
  async stream() {
    const enc = new TextEncoder();
    const lines = ['data: {"choices":[{"delta":{"content":"兄"}}]}\n\n', 'data: [DONE]\n\n'];
    let i = 0;
    const body = new ReadableStream({ pull(c) { if (i < lines.length) c.enqueue(enc.encode(lines[i++])); else c.close(); } });
    return new Response(body, { status: 200 });
  }
}

class NoKeyAiService extends AiService {
  constructor() { super({ apiKey: '', baseUrl: 'x', model: 'm', enabled: false, maxPromptChars: 24000, corsOrigins: [], timeoutMs: 30000 }); }
  async stream(): Promise<Response> { throw new ServiceUnavailableException('AI is not configured on the server (set GROQ_API_KEY).'); }
}

async function boot(service: AiService): Promise<{ app: INestApplication; base: string }> {
  const mod = await Test.createTestingModule({ imports: [AppModule.forRoot()] })
    .overrideProvider(AiService).useValue(service).compile();
  const app = mod.createNestApplication({ logger: false });
  await app.listen(0);
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, base };
}

let app: INestApplication;
let base: string;
beforeAll(async () => { ({ app, base } = await boot(new FakeAiService())); });
afterAll(async () => { await app.close(); });

describe('POST /api/ai (real HTTP, faked provider)', () => {
  it('health probe responds', async () => {
    const r = await fetch(`${base}/api/ai/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it('streams the provider reply back to the caller, with no key leak', async () => {
    const r = await fetch(`${base}/api/ai`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Translate into Japanese: brother' }),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('兄');
    expect(text).toContain('[DONE]');
    expect(text).not.toContain(SECRET); // key never in the browser-facing response
  });

  it('400s on an empty prompt (validation runs before any provider call)', async () => {
    const r = await fetch(`${base}/api/ai`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain(SECRET);
  });
});

describe('POST /api/ai with NO key configured', () => {
  it('503s with a clear "not configured" message and no leak', async () => {
    const { app: noKeyApp, base: noKeyBase } = await boot(new NoKeyAiService());
    const r = await fetch(`${noKeyBase}/api/ai`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(r.status).toBe(503);
    expect((await r.text()).toLowerCase()).toContain('not configured');
    await noKeyApp.close();
  });
});
