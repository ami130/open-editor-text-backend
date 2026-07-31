/**
 * ai.service.ts — the secure proxy core. Turns the editor's { prompt, system }
 * into an OpenAI-compatible chat-completions request, attaches the SERVER-SIDE
 * API key, and returns the upstream streaming response for the controller to
 * pipe back to the browser.
 *
 * Security invariants:
 *   • The API key is read from config (env) and set only on the OUTBOUND
 *     request to the provider. It is never returned, logged, or exposed.
 *   • The browser's input is validated + size-capped before we spend a token.
 *   • We forward ONLY prompt/system — never arbitrary fields the client sends,
 *     so a client can't inject model/params/keys of its own.
 */
import { Injectable, Inject, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { AI_CONFIG, AiConfig } from '../config/ai.config';

export interface AiRequest {
  prompt: string;
  system?: string;
}

@Injectable()
export class AiService {
  constructor(@Inject(AI_CONFIG) private readonly cfg: AiConfig) {}

  /** Validate + normalize the client request (throws on bad input). */
  validate(body: unknown): AiRequest {
    const b = (body || {}) as Record<string, unknown>;
    const prompt = typeof b.prompt === 'string' ? b.prompt : '';
    const system = typeof b.system === 'string' ? b.system : '';
    if (!prompt.trim()) throw new BadRequestException('prompt is required');
    if (prompt.length > this.cfg.maxPromptChars) {
      throw new BadRequestException(`prompt exceeds ${this.cfg.maxPromptChars} characters`);
    }
    // (audit #3) Cap `system` too — it's forwarded upstream just like `prompt`, so
    // leaving it unbounded lets a caller pass a tiny prompt + a multi-MB system
    // string to inflate upstream token spend past the intended cap (the per-IP
    // throttle bounds frequency, not per-request size).
    if (system.length > this.cfg.maxPromptChars) {
      throw new BadRequestException(`system exceeds ${this.cfg.maxPromptChars} characters`);
    }
    return { prompt, system };
  }

  /** Build the OpenAI-compatible upstream request (pure — unit-testable). */
  buildUpstreamRequest(req: AiRequest): { url: string; init: RequestInit } {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system && req.system.trim()) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });
    return {
      url: `${this.cfg.baseUrl}/chat/completions`,
      init: {
        method: 'POST',
        headers: {
          // The secret lives ONLY here, on the server→provider hop.
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.cfg.model, stream: true, messages }),
      },
    };
  }

  /**
   * Call the provider and return the raw streaming Response. The controller
   * pipes response.body straight to the browser — the reply is already in the
   * OpenAI `data: {choices:[{delta:{content}}]}` SSE shape that the editor's
   * aiComplete() reads natively, so no re-framing is needed.
   */
  async stream(req: AiRequest, signal?: AbortSignal): Promise<Response> {
    if (!this.cfg.enabled) {
      // No key configured → a clear 503, never a leak or a confusing 500.
      throw new ServiceUnavailableException(
        'AI is not configured on the server (set GROQ_API_KEY). See apps/backend/README.md.',
      );
    }
    const { url, init } = this.buildUpstreamRequest(req);
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    // Combine caller-abort (browser disconnect) with our timeout.
    const combined = signal ? anySignal([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: combined });
    } catch (err) {
      throw new ServiceUnavailableException('Could not reach the AI provider.');
    }
    if (!res.ok) {
      // Surface a sanitized status — do NOT forward the provider's body (it may
      // echo request details); the key is never in our error either.
      throw new ServiceUnavailableException(`AI provider error (status ${res.status}).`);
    }
    return res;
  }
}

/** Minimal AbortSignal.any polyfill (Node 20+ has it, but be safe). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals);
  }
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
