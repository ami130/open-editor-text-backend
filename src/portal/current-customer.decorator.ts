/**
 * current-customer.decorator.ts — inject the authenticated customer claims
 * (set by CustomerAuthGuard as request.customer) into a portal handler.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface CustomerClaims { sub: string; email: string; type: 'customer'; }

export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CustomerClaims | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return req.customer;
  },
);
