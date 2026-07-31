/**
 * ai.module.ts — wires the AI proxy: config provider + service + controller.
 */
import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AI_CONFIG, loadAiConfig } from '../config/ai.config';

@Module({
  controllers: [AiController],
  providers: [
    { provide: AI_CONFIG, useFactory: () => loadAiConfig() },
    AiService,
  ],
  exports: [AiService],
})
export class AiModule {}
