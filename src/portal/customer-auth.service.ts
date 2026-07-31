/**
 * customer-auth.service.ts — passwordless auth for the self-serve customer
 * portal (Phase 4a). Customers have no password (created implicitly at
 * checkout), so login is a magic-link:
 *
 *   1. requestLink(email): if the email is a known customer, rotate its
 *      single-use `magicNonce` and email a short-lived link carrying a
 *      type:'magic' JWT { sub, nonce }. ALWAYS returns the same result whether
 *      or not the email exists (anti-enumeration).
 *   2. consumeLink(token): verify the magic JWT, check its nonce STILL matches
 *      (single-use — a used/older link fails), rotate the nonce again to burn
 *      it, and return the customer id so the controller can set a session.
 *   3. session tokens: type:'customer' JWTs under a SEPARATE secret, so a
 *      customer token can never be presented on an admin route and vice-versa.
 *
 * No DB session table: the nonce gives single-use for the LINK; the session is
 * a short-lived stateless cookie JWT (re-login is cheap via another link).
 */
import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { CUSTOMER_AUTH_CONFIG, CustomerAuthConfig } from '../config/customer-auth.config';
import { CustomerEntity } from '../licensing/entities/customer.entity';
import { EmailService } from '../billing/email.service';

// Pin the algorithm — never let a token header choose it (alg-confusion defense).
const JWT_ALG = 'HS256' as const;

interface MagicClaims { sub: string; nonce: string; type: 'magic'; }
interface CustomerSessionClaims { sub: string; email: string; epoch: number; type: 'customer'; }

@Injectable()
export class CustomerAuthService {
  constructor(
    @Inject(CUSTOMER_AUTH_CONFIG) private readonly cfg: CustomerAuthConfig,
    @Inject(JwtService) private readonly jwt: JwtService,
    @InjectRepository(CustomerEntity) private readonly customers: Repository<CustomerEntity>,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  /**
   * Begin a portal login. If `email` maps to a known customer, rotate its nonce
   * and email a one-time link. Returns void either way — the CALLER must send an
   * identical response regardless, so an attacker can't tell whether an email is
   * a customer (enumeration defense).
   */
  async requestLink(rawEmail: string): Promise<void> {
    const email = String(rawEmail || '').toLowerCase().trim();
    if (!email) return; // caller still returns the generic success
    const customer = await this.customers.findOne({ where: { email } });
    if (!customer) return; // unknown email → silently do nothing (no oracle)

    const nonce = randomUUID();
    await this.customers.update({ id: customer.id }, { magicNonce: nonce });

    const token = this.jwt.sign(
      { sub: customer.id, nonce, type: 'magic' } as MagicClaims,
      { secret: this.cfg.magicSecret, algorithm: JWT_ALG, expiresIn: this.cfg.magicTtl },
    );
    const link = `${this.cfg.portalBaseUrl}/portal/verify?token=${encodeURIComponent(token)}`;
    await this.email.sendPortalLink({ to: email, customerName: customer.name, link });
  }

  /**
   * Consume a magic-link token → the customer id, or throw 401. Single-use: the
   * token's nonce must equal the customer's CURRENT `magicNonce`; on success we
   * rotate the nonce (burn the link) so it can't be replayed within its TTL.
   */
  async consumeLink(token: string): Promise<{ id: string; email: string; epoch: number }> {
    let claims: MagicClaims;
    try {
      claims = this.jwt.verify<MagicClaims>(token, { secret: this.cfg.magicSecret, algorithms: [JWT_ALG] });
      if (claims.type !== 'magic') throw new Error('wrong type');
    } catch {
      throw new UnauthorizedException('invalid or expired link');
    }
    // magicNonce is select:false — request it (+ the session epoch) explicitly.
    const customer = await this.customers
      .createQueryBuilder('c')
      .addSelect('c.magicNonce')
      .where('c.id = :id', { id: claims.sub })
      .getOne();
    if (!customer || !customer.magicNonce || customer.magicNonce !== claims.nonce) {
      throw new UnauthorizedException('this link has already been used or expired');
    }
    // Burn the nonce so the link can't be used twice.
    await this.customers.update({ id: customer.id }, { magicNonce: randomUUID() });
    return { id: customer.id, email: customer.email, epoch: customer.sessionEpoch };
  }

  /** Mint a short-lived customer SESSION token (cookie). Separate secret + type.
   *  Embeds the customer's current sessionEpoch so a logout/revoke can kill it. */
  issueSession(customer: { id: string; email: string; epoch: number }): string {
    return this.jwt.sign(
      { sub: customer.id, email: customer.email, epoch: customer.epoch, type: 'customer' } as CustomerSessionClaims,
      { secret: this.cfg.sessionSecret, algorithm: JWT_ALG, expiresIn: this.cfg.sessionTtl },
    );
  }

  /** Verify a customer SESSION token (signature/expiry/type). No DB — the epoch
   *  freshness check is done in the guard (which has the customer row). */
  verifySession(token: string): CustomerSessionClaims {
    try {
      const c = this.jwt.verify<CustomerSessionClaims>(token, {
        secret: this.cfg.sessionSecret, algorithms: [JWT_ALG],
      });
      if (c.type !== 'customer') throw new Error('wrong type');
      return c;
    } catch {
      throw new UnauthorizedException('invalid or expired customer session');
    }
  }

  /** The customer's current session epoch (for the guard's freshness check).
   *  null if the customer no longer exists. */
  async currentEpoch(customerId: string): Promise<number | null> {
    const c = await this.customers.findOne({ where: { id: customerId } });
    return c ? c.sessionEpoch : null;
  }

  /** Revoke ALL of a customer's sessions (logout-everywhere) by bumping the epoch. */
  async bumpSessionEpoch(customerId: string): Promise<void> {
    await this.customers.increment({ id: customerId }, 'sessionEpoch', 1);
  }
}
