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
import { json, urlencoded } from 'express';
import type { Request } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadAiConfig } from './config/ai.config';
import { loadDatabaseConfig } from './config/database.config';
import { loadAuthConfig } from './config/auth.config';
import {
  BUNDLE_UPLOAD_LIMIT, loadDeliveryConfig, deliveryInstanceCount,
} from './config/delivery.config';
import { isAbsolute } from 'node:path';

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

  // Body limit raised for engine bundle publishing (§1.4a). A ~640 KB bundle
  // is ~854 KB base64, which Express's 100 KB default would reject with an
  // opaque 413. Only the admin publish route needs this; the limit is kept
  // tight enough that it is not a useful amplification target.
  //
  // ⚠️ THE WEBHOOK MUST KEEP ITS RAW BYTES. Stripe signs the EXACT body it
  // sent; verification re-computes an HMAC over those bytes. A JSON parser that
  // consumes the stream first leaves `req.rawBody` undefined and every webhook
  // fails 400 — payments succeed at Stripe while orders sit `pending` forever
  // and no licence is ever minted.
  //
  // `verify` is the documented body-parser hook that sees the buffer BEFORE
  // parsing, so we stash it ourselves. This is more robust than skipping the
  // parser for the webhook path: it keeps one parser (no route-ordering
  // subtleties) and works no matter where the route is mounted.
  //
  // Found by driving a REAL signed webhook against the running server. Every
  // e2e test passed throughout, because the test app enables rawBody but never
  // installs this parser — so the tests never reproduced production's ordering.
  const keepRawBody = (req: RawBodyRequest<Request>, _res: unknown, buf: Buffer) => {
    if (buf?.length) req.rawBody = buf;
  };
  app.use(json({ limit: BUNDLE_UPLOAD_LIMIT, verify: keepRawBody }));
  app.use(urlencoded({ extended: true, limit: BUNDLE_UPLOAD_LIMIT, verify: keepRawBody }));

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

  /**
   * Delivery misconfiguration is uniquely nasty: it breaks premium ONLY.
   * Free sessions keep working, so a deploy smoke-test passes while every
   * paying customer gets a 503 — and the first report comes from them, not us.
   * Say it at boot, where it is cheap to notice.
   */
  const delivery = loadDeliveryConfig();

  /**
   * REFUSE to start on a multi-instance deployment (G2).
   *
   * Local-disk bundle storage is per-instance: publishing writes the bytes to
   * whichever server handled the request, so with N instances roughly (N-1)/N
   * of engine downloads 404 — at random, per server, with nothing in the logs
   * to explain it. A comment in the driver could not prevent that; this can.
   */
  if (db.enabled && deliveryInstanceCount() > 1) {
    // eslint-disable-next-line no-console
    console.error(
      `[open-editor backend] FATAL: DELIVERY_INSTANCES=${deliveryInstanceCount()} but engine `
      + 'bundles are stored on LOCAL DISK, which is per-instance. Each server would hold only '
      + 'part of the set and engine downloads would 404 at random. Use shared storage '
      + '(Phase 2 object storage), or run a single instance.',
    );
    process.exit(1);
  }

  if (db.enabled && !delivery.signingEnabled) {
    // eslint-disable-next-line no-console
    console.warn(
      '[open-editor backend] WARNING: DELIVERY_URL_SECRET is not set — premium '
      + 'engine delivery will fail with 503 for every LICENSED customer. Free '
      + 'sessions are unaffected, so this will not show up in a basic smoke test. '
      + 'Generate one with: openssl rand -hex 32',
    );
  }
  if (db.enabled && !isAbsolute(delivery.bundleDir)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[open-editor backend] WARNING: DELIVERY_BUNDLE_DIR is relative ("${delivery.bundleDir}") `
      + `— bundles resolve against the current working directory (${process.cwd()}). `
      + 'Set an absolute path on a persistent volume, or a redeploy will lose every bundle.',
    );
  }
}

bootstrap();
