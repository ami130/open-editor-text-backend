/**
 * observability.module.ts — request-id middleware + structured access logging.
 * Applied app-wide. The interceptor is registered as APP_INTERCEPTOR so it
 * wraps every handler; the middleware runs for every route to assign the id.
 */
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestIdMiddleware } from './request-context';
import { LoggingInterceptor } from './logging.interceptor';

@Module({
  providers: [
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
