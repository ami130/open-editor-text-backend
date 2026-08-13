/**
 * health.controller.ts — GET /health. Reports overall status plus each
 * subsystem. The DB check is tolerant: if the database is disabled it reports
 * "disabled" (not a failure); if enabled it pings the connection.
 */
import { Controller, Get, Optional, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadDatabaseConfig } from '../config/database.config';
import { loadAiConfig } from '../config/ai.config';
import { loadBillingConfig } from '../config/billing.config';
import { loadDeliveryConfig } from '../config/delivery.config';
import { EngineVersionService } from '../licensing/engine-version.service';
import { Public } from '../auth/decorators';

@Public() // health is an unauthenticated readiness probe
@Controller('health')
export class HealthController {
  // Optional: only present when DatabaseModule registered TypeORM. Injected via
  // getDataSourceToken() name so it resolves without a hard dependency.
  constructor(
    @Optional() @Inject(DataSource) private readonly dataSource?: DataSource,
    // Absent when DeliveryModule was not registered (no database) — the check
    // then reports 'disabled' rather than failing.
    @Optional() private readonly versions?: EngineVersionService,
  ) {}

  @Get()
  async check() {
    const db = await this.checkDb();
    const ai = loadAiConfig();
    const delivery = await this.checkDelivery();
    const email = this.checkEmail();
    return {
      // Email is NOT part of the degraded decision: a mail outage must never
      // make the service look down. Fulfilment succeeds without it and the key
      // stays retrievable — losing email costs a convenience, not the product.
      status: db.status === 'down' || delivery.status === 'down' ? 'degraded' : 'ok',
      service: 'open-editor-backend',
      checks: {
        database: db,
        ai: { status: ai.enabled ? 'configured' : 'not-configured' },
        delivery,
        email,
      },
      timestamp: nowIso(),
    };
  }

  /**
   * WHICH mail transport is configured — never whether one WORKS.
   *
   * Added after a real diagnosis cost far longer than it should have: a
   * licence email silently did not arrive, and there was no way to tell
   * "no transport configured" from "transport configured but failing".
   * Both looked identical from outside, and the two have completely
   * different fixes.
   *
   * Deliberately reports CONFIGURATION only — no send attempt, no
   * credentials, not even the host. A health endpoint is public-ish and
   * must not become a way to probe someone's mail setup, and it must not
   * fire an email every time a monitor polls it.
   */
  private checkEmail(): { status: string; transport: string } {
    const cfg = loadBillingConfig();
    if (cfg.smtp.host) return { status: 'configured', transport: 'smtp' };
    if (cfg.emailWebhookUrl) return { status: 'configured', transport: 'webhook' };
    // No transport: sends are logged and dropped. Licences are still minted,
    // so this is 'not-configured', not 'down'.
    return { status: 'not-configured', transport: 'none' };
  }

  /**
   * Can a visitor actually be served an editor right now? (G4)
   *
   * Not a config check — an END-TO-END one. It resolves the default version the
   * way a real session does and confirms the BYTES exist, because the two live
   * in different places and drift apart:
   *
   *   • a redeploy onto an ephemeral filesystem keeps every registry row and
   *     deletes every bundle
   *   • a missing DELIVERY_URL_SECRET breaks premium ONLY, so free traffic
   *     looks perfectly healthy while paying customers get 503s
   *
   * Both were previously invisible until a customer complained. Reported as
   * `down` so an ordinary uptime probe catches them.
   */
  private async checkDelivery(): Promise<{
    status: 'up' | 'down' | 'disabled';
    version?: string;
    message?: string;
  }> {
    if (!loadDatabaseConfig().enabled) return { status: 'disabled' };
    // The service is absent when DeliveryModule was not registered — that is a
    // deployment without delivery, not a broken one.
    if (!this.versions) return { status: 'disabled' };

    try {
      const { channelDefault, globalDefault } = await this.versions.defaultsFor('stable');
      const version = channelDefault || globalDefault;
      if (!version) {
        return { status: 'down', message: 'no default engine version is configured' };
      }

      // isComplete() checks BYTES, not just rows — the distinction that makes
      // this check worth having.
      const { complete, missingPlans } = await this.versions.isComplete(version);
      if (!complete) {
        return {
          status: 'down',
          version,
          message: `bundle bytes missing for: ${missingPlans.join(', ')} — re-publish or restore them`,
        };
      }

      if (!loadDeliveryConfig().signingEnabled) {
        return {
          status: 'down',
          version,
          message: 'DELIVERY_URL_SECRET is not set — premium delivery will 503',
        };
      }

      return { status: 'up', version };
    } catch {
      return { status: 'down', message: 'delivery check failed' };
    }
  }

  private async checkDb(): Promise<{ status: 'up' | 'down' | 'disabled'; message?: string }> {
    const cfg = loadDatabaseConfig();
    if (!cfg.enabled) return { status: 'disabled' };
    if (!this.dataSource || !this.dataSource.isInitialized) {
      return { status: 'down', message: 'not connected' };
    }
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'up' };
    } catch (e) {
      return { status: 'down', message: 'query failed' };
    }
  }
}

// Date.now()/new Date() are fine at runtime here (not in the workflow sandbox).
function nowIso(): string {
  return new Date().toISOString();
}
