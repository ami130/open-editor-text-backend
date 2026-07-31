/**
 * health.module.ts — exposes GET /health (DB + AI subsystem status).
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
