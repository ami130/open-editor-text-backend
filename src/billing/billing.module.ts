/**
 * billing.module.ts — Stripe billing (Phase F). DB-gated like AdminModule.
 * Reuses LicenseService (from the GLOBAL LicensingModule) to mint licenses on
 * paid checkout. Registers the order + idempotency entities and the licensing
 * repos the OrderService needs (package/customer).
 *
 * The STRIPE_CLIENT token maps to the real StripeService in the app; tests
 * override it with a fake (no network, no keys).
 */
import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from './entities/order.entity';
import { ProcessedStripeEventEntity } from './entities/processed-stripe-event.entity';
import { PackageEntity } from '../licensing/entities/package.entity';
import { CustomerEntity } from '../licensing/entities/customer.entity';
import { BILLING_CONFIG, loadBillingConfig } from '../config/billing.config';
import { StripeService, STRIPE_CLIENT } from './stripe.service';
import { EmailService } from './email.service';
import { OrderService } from './order.service';
import { BillingController } from './billing.controller';
import { PublicController } from './public.controller';
import { OrderAdminController, LicenseEmailAdminController } from './order-admin.controller';
import { DeliveryModule } from '../delivery/delivery.module';

@Module({})
export class BillingModule {
  static forRoot(): DynamicModule {
    return {
      module: BillingModule,
      imports: [
        TypeOrmModule.forFeature([
          OrderEntity, ProcessedStripeEventEntity, PackageEntity, CustomerEntity,
        ]),
        // §2.4 — LicenseActivationService, so fulfilment can arm the buyer's
        // one-time activation claim. Sibling modules do NOT see each other's
        // exports: without this import the @Optional() injection resolves to
        // `undefined` and activation would silently never be armed, while every
        // test of the purchase flow still passed.
        DeliveryModule.forRoot(),
      ],
      controllers: [BillingController, PublicController, OrderAdminController, LicenseEmailAdminController],
      providers: [
        { provide: BILLING_CONFIG, useFactory: () => loadBillingConfig() },
        // STRIPE_CLIENT → the real service (overridable in tests).
        StripeService,
        { provide: STRIPE_CLIENT, useExisting: StripeService },
        EmailService,
        OrderService,
      ],
    };
  }
}
