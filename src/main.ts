/**
 * main.ts — bootstrap. CORS is restricted to the configured editor origins so
 * only your own frontend(s) can call the proxy from a browser.
 */
import 'reflect-metadata';
// Load .env EAGERLY, before anything reads process.env. AppModule.forRoot()
// inspects DB_ENABLED at module-definition time (to decide whether to include
// Auth/Admin), which happens before Nest's ConfigModule would load .env — so we
// must populate process.env here first, or those modules silently don't load.
import { config as loadEnv } from 'dotenv';
loadEnv();
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadAiConfig } from './config/ai.config';
import { loadDatabaseConfig } from './config/database.config';
import { loadAuthConfig } from './config/auth.config';

async function bootstrap() {
  // rawBody:true makes Nest keep the unparsed request body on req.rawBody
  // (needed for Stripe webhook signature verification) WHILE still parsing JSON
  // for every other route. Cleaner + safer than per-route express middleware
  // ordering.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(), { logger: ['error', 'warn', 'log'], rawBody: true });
  const cfg = loadAiConfig();
  const db = loadDatabaseConfig();

  // Behind a reverse proxy (TLS terminator / load balancer), the real client IP
  // is in X-Forwarded-For. Enable `trust proxy` so rate limiting and the CSRF
  // Origin check key on the actual client, not the proxy. Opt-in via env
  // (TRUST_PROXY=1 or a hop-count) so it's off for direct local dev where a
  // spoofable XFF must NOT be trusted.
  const trustProxy = (process.env.TRUST_PROXY || '').trim();
  if (trustProxy) {
    const hops = parseInt(trustProxy, 10);
    app.set('trust proxy', Number.isFinite(hops) ? hops : trustProxy);
  }

  // Security headers. This is a JSON API (no HTML rendered here), so helmet's
  // defaults are appropriate: HSTS, nosniff, no-referrer, frameguard, hidden
  // X-Powered-By, etc. We DISABLE helmet's default CSP — a restrictive
  // connect/script CSP belongs on the web app that renders pages, and applying
  // it to API JSON responses adds nothing but risk of breaking a client.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Parse cookies (the auth refresh token rides in an httpOnly cookie).
  app.use(cookieParser());

  // NOTE: the global ValidationPipe is registered as an APP_PIPE provider in
  // SecurityModule (so prod + tests share the exact same validation, no drift).

  // CORS: allow the union of AI editor origins + admin-panel origins, and the
  // full method set the admin API uses (PATCH/DELETE, not just GET/POST).
  // credentials:true so the admin panel can send the refresh cookie.
  const auth = loadAuthConfig();
  const origins = [...new Set([...cfg.corsOrigins, ...auth.adminOrigins])];
  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  const port = parseInt(process.env.PORT || '', 10) || 8787;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(
    `[open-editor backend] listening on :${port}`
    + (cfg.enabled ? '' : ' — WARNING: no AI key set, /api/ai will 503')
    + (db.enabled ? ` — DB: ${db.host}:${db.port}/${db.database}` : ' — DB: disabled'),
  );
}

bootstrap();
