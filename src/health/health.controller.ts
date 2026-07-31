/**
 * health.controller.ts — GET /health. Reports overall status plus each
 * subsystem. The DB check is tolerant: if the database is disabled it reports
 * "disabled" (not a failure); if enabled it pings the connection.
 */
import { Controller, Get, Optional, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadDatabaseConfig } from '../config/database.config';
import { loadAiConfig } from '../config/ai.config';
import { Public } from '../auth/decorators';

@Public() // health is an unauthenticated readiness probe
@Controller('health')
export class HealthController {
  // Optional: only present when DatabaseModule registered TypeORM. Injected via
  // getDataSourceToken() name so it resolves without a hard dependency.
  constructor(@Optional() @Inject(DataSource) private readonly dataSource?: DataSource) {}

  @Get()
  async check() {
    const db = await this.checkDb();
    const ai = loadAiConfig();
    return {
      status: db.status === 'down' ? 'degraded' : 'ok',
      service: 'open-editor-backend',
      checks: {
        database: db,
        ai: { status: ai.enabled ? 'configured' : 'not-configured' },
      },
      timestamp: nowIso(),
    };
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
