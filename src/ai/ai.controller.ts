/**
 * ai.controller.ts — POST /api/ai. The single endpoint the browser editor's
 * `aiEndpoint` points at. Validates the body, asks AiService to stream from the
 * provider, and pipes the SSE bytes straight back to the browser. The API key
 * is never part of this exchange — the browser only ever sees this server.
 */
import { Controller, Post, Body, Req, Res, Get, Inject } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AiService } from './ai.service';
import { Public } from '../auth/decorators';
import { loadThrottleConfig } from '../config/throttle.config';

const T = loadThrottleConfig();

// The AI proxy is called by the editor with no admin session — it's @Public.
// ⚠️ OPEN-PROXY COST NOTE: with no admin auth, the ONLY guards are this per-IP
// rate limit + CORS (CORS restricts browsers, NOT scripts/curl). Anyone who
// learns the URL can spend your LLM quota via rotating IPs. This is acceptable
// for the BYO-endpoint model, but if you expose it publicly, put your own auth
// (a shared token / signed request) or a per-key budget in front. The per-IP
// limiter is in-memory (per node) — add a shared store (Redis) at scale.
@Public()
@Controller('api/ai')
export class AiController {
  // Explicit @Inject so DI works even under build pipelines (e.g. esbuild in
  // the test runner) that don't emit `design:paramtypes` metadata.
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  /** Lightweight readiness probe (also lets the frontend detect "not configured"). */
  @Get('health')
  health() {
    return { ok: true, service: 'ai-proxy' };
  }

  @Throttle({ default: { ttl: T.aiTtlMs, limit: T.aiLimit } })
  @Post()
  async complete(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const parsed = this.ai.validate(body); // throws 400 on bad input

    // Abort the upstream call if the browser disconnects mid-stream (don't keep
    // burning provider tokens for a client that's gone).
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    const upstream = await this.ai.stream(parsed, ac.signal); // throws 503 on provider/config failure

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)

    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // value is a Uint8Array chunk of the provider's SSE stream; forward as-is.
        res.write(Buffer.from(value));
      }
    } catch {
      // client disconnect / upstream hiccup — just stop cleanly.
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      res.end();
    }
  }
}
