/**
 * ai.service.test.ts — the security-critical + pure logic of the proxy:
 * validation, the upstream request shape (key placement), config gating, and
 * the streaming passthrough with a MOCKED provider (no real key/network).
 */
import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AiService } from '../src/ai/ai.service';
import { loadAiConfig } from '../src/config/ai.config';

const cfg = (over: Record<string, string> = {}) =>
  loadAiConfig({ GROQ_API_KEY: 'test-secret-key', ...over } as NodeJS.ProcessEnv);

afterEach(() => vi.restoreAllMocks());

describe('config', () => {
  it('reads key + defaults; enabled only when a key is present', () => {
    expect(loadAiConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
    const c = cfg();
    expect(c.enabled).toBe(true);
    expect(c.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(c.model).toBe('llama-3.3-70b-versatile');
  });
  it('AI_API_KEY works as an alias for a non-Groq provider', () => {
    expect(loadAiConfig({ AI_API_KEY: 'k' } as NodeJS.ProcessEnv).enabled).toBe(true);
  });
  it('clamps guard values and parses CORS origins', () => {
    const c = loadAiConfig({ GROQ_API_KEY: 'k', AI_MAX_PROMPT_CHARS: '999999999', AI_CORS_ORIGINS: 'a, b ,c' } as NodeJS.ProcessEnv);
    expect(c.maxPromptChars).toBe(200000); // clamped to max
    expect(c.corsOrigins).toEqual(['a', 'b', 'c']);
  });
});

describe('AiService.validate', () => {
  const svc = () => new AiService(cfg());
  it('requires a non-empty prompt', () => {
    expect(() => svc().validate({})).toThrow(/prompt is required/);
    expect(() => svc().validate({ prompt: '   ' })).toThrow(/prompt is required/);
  });
  it('rejects an over-long prompt', () => {
    const s = new AiService(cfg({ AI_MAX_PROMPT_CHARS: '100' }));
    expect(() => s.validate({ prompt: 'x'.repeat(101) })).toThrow(/prompt exceeds/);
  });
  it('rejects an over-long system too (audit #3: cost-amplification guard)', () => {
    const s = new AiService(cfg({ AI_MAX_PROMPT_CHARS: '100' }));
    // small prompt (passes) + oversized system must still be rejected.
    expect(() => s.validate({ prompt: 'hi', system: 'x'.repeat(101) })).toThrow(/system exceeds/);
  });
  it('accepts prompt + optional system', () => {
    expect(svc().validate({ prompt: 'hi', system: 'be brief' })).toEqual({ prompt: 'hi', system: 'be brief' });
  });
});

describe('AiService.buildUpstreamRequest (SECURITY: key placement + no client params)', () => {
  it('puts the key ONLY in the upstream Authorization header, fixes model/stream server-side', () => {
    const svc = new AiService(cfg());
    const { url, init } = svc.buildUpstreamRequest({ prompt: 'Translate to Japanese: brother', system: 'sys' });
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-secret-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('llama-3.3-70b-versatile'); // server-fixed, not client-supplied
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Translate to Japanese: brother' },
    ]);
  });
  it('omits the system message when empty', () => {
    const body = JSON.parse(new AiService(cfg()).buildUpstreamRequest({ prompt: 'hi' }).init.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('AiService.stream', () => {
  it('503s with a clear message when no key is configured (never leaks/500s)', async () => {
    const svc = new AiService(loadAiConfig({} as NodeJS.ProcessEnv));
    await expect(svc.stream({ prompt: 'hi' })).rejects.toThrow(/not configured/i);
  });
  it('calls the provider with the key and returns the streaming response', async () => {
    const svc = new AiService(cfg());
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await svc.stream({ prompt: 'hi' });
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-secret-key');
  });
  it('surfaces a sanitized 503 on a provider HTTP error (does not forward the body)', async () => {
    const svc = new AiService(cfg());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('SECRET LEAK IN BODY', { status: 401 })));
    await expect(svc.stream({ prompt: 'hi' })).rejects.toThrow(/AI provider error \(status 401\)/);
    // the rejection message must NOT contain the provider body
    await svc.stream({ prompt: 'hi' }).catch((e: Error) => expect(e.message).not.toContain('SECRET LEAK'));
  });
  it('503s (not crashes) when the provider is unreachable', async () => {
    const svc = new AiService(cfg());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(svc.stream({ prompt: 'hi' })).rejects.toThrow(/Could not reach/);
  });
});
