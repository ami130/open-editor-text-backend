/**
 * logging.interceptor.ts — one structured JSON access-log line per request.
 *
 * Emits `{ level, time, reqId, method, path, status, ms }` on completion (and on
 * error, with the mapped status). Deliberately logs NO bodies, NO headers, NO
 * query values — those can carry secrets (tokens, passwords, license keys). The
 * request id ties the line to any errors logged elsewhere.
 *
 * Toggle with LOG_FORMAT=json (default in production) — otherwise stays quiet
 * and lets Nest's dev logger do its thing.
 */
import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Response } from 'express';
import type { RequestWithId } from './request-context';

const JSON_LOGS = (process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'dev')) === 'json';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!JSON_LOGS || context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res = http.getResponse<Response>();
    const start = Date.now();
    const method = req.method;
    // Log the ROUTE PATH (req.route) when available, else the raw path with the
    // query string stripped — query values may contain secrets.
    const path = (req.originalUrl || req.url || '').split('?')[0];

    const done = (error?: unknown) => {
      const ms = Date.now() - start;
      const status = res.statusCode;
      const line = {
        level: error || status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        time: new Date().toISOString(),
        reqId: req.requestId,
        method,
        path,
        status,
        ms,
      };
      // Single-line JSON to stdout — parseable by any log aggregator.
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(line));
    };

    return next.handle().pipe(
      tap({ next: () => done(), error: (e) => done(e) }),
    );
  }
}
