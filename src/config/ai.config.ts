/**
 * ai.config.ts — typed, validated configuration for the AI proxy.
 *
 * The whole security model rests on ONE fact: the provider API key is read from
 * the server environment (process.env) and NEVER leaves this server. It is not
 * in any response, not logged, and not sent to the browser. The browser only
 * ever talks to THIS backend.
 */

export interface AiConfig {
  /** Provider API key — server-only secret (Groq's free tier by default). */
  apiKey: string;
  /** OpenAI-compatible chat-completions base URL. Groq by default. */
  baseUrl: string;
  /** Model id. Swap this one string to move Groq → OpenAI/Anthropic gateway. */
  model: string;
  /** Whether a key is present (the proxy 503s cleanly when it isn't). */
  enabled: boolean;
  /** Max characters of user prompt accepted (abuse / cost guard). */
  maxPromptChars: number;
  /** Allowed CORS origins for the browser editor (comma-separated env). */
  corsOrigins: string[];
  /** Request timeout to the upstream provider, ms. */
  timeoutMs: number;
}

/** Read + normalize AI config from the environment. Pure; no side effects. */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const apiKey = (env.GROQ_API_KEY || env.AI_API_KEY || '').trim();
  const baseUrl = (env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const model = (env.AI_MODEL || 'llama-3.3-70b-versatile').trim();
  const corsOrigins = (env.AI_CORS_ORIGINS || 'http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const maxPromptChars = clampInt(env.AI_MAX_PROMPT_CHARS, 24000, 100, 200000);
  const timeoutMs = clampInt(env.AI_TIMEOUT_MS, 30000, 1000, 120000);
  return {
    apiKey,
    baseUrl,
    model,
    enabled: apiKey.length > 0,
    maxPromptChars,
    corsOrigins,
    timeoutMs,
  };
}

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export const AI_CONFIG = 'AI_CONFIG';
