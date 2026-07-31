/**
 * request-context.ts — a per-request id used for log correlation.
 *
 * Middleware assigns each request an id (an incoming `X-Request-Id` if present
 * and sane, else a generated uuid), stashes it on the request, and echoes it on
 * the response so a client/proxy can correlate. The logging interceptor reads
 * it. No async-local-storage needed — the id rides on the request object.
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestWithId extends Request {
  requestId?: string;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithId, res: Response, next: NextFunction): void {
    const incoming = String(req.headers[REQUEST_ID_HEADER] || '').trim();
    // Accept a client-supplied id only if it's short + safe (no log injection).
    const id = /^[A-Za-z0-9._-]{1,80}$/.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  }
}
