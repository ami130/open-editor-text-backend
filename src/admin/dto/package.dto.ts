/**
 * package.dto.ts — create/update a package. Enforces the M1 economics
 * validation the audit flagged: non-negative price, ISO-4217 currency, a fixed
 * billing-interval enum, sane TTL bounds, and at least one feature.
 */
import {
  IsString, IsInt, Min, Max, IsArray, ArrayNotEmpty, IsBoolean, IsOptional,
  IsIn, Length,
} from 'class-validator';
// Single source of truth for the interval enum (now incl. 'lifetime').
import { BILLING_INTERVALS } from '../../licensing/duration-policy';

export class CreatePackageDto {
  @IsString() @Length(1, 120)
  name!: string;

  @IsOptional() @IsString() @Length(0, 500)
  description?: string;

  /** Price in the smallest currency unit (cents). Never negative. */
  @IsInt() @Min(0) @Max(100_000_000)
  priceCents!: number;

  /**
   * Currency is USD-only for this product — optional in the request (the
   * service defaults it to USD); if sent, it MUST be 'USD'. No other currency
   * is accepted, since checkout charges in USD only.
   */
  @IsOptional() @IsIn(['USD'], { message: 'currency must be USD' })
  currency?: string;

  @IsIn(BILLING_INTERVALS)
  billingInterval!: (typeof BILLING_INTERVALS)[number];

  @IsOptional() @IsBoolean()
  domainBound?: boolean;

  /**
   * How many domains one licence of this plan may bind. 0 = unlimited.
   *
   * This is what makes "one payment, one place" a rule rather than a
   * convention: `domainBound` requires domains to be named, but never limited
   * how many. Defaults to 0 so existing plans are unaffected — a cap is opt-in.
   */
  @IsOptional() @IsInt() @Min(0) @Max(1000)
  maxDomains?: number;

  /**
   * Distinct browser installs one licence may serve (§2.4). 0 = unlimited.
   * Closes the unbounded `localhost` exemption in domain binding.
   */
  @IsOptional() @IsInt() @Min(0) @Max(10_000)
  maxInstalls?: number;

  /**
   * Explicit TTL override (seconds). Omit/null (normal) → the license TTL is
   * DERIVED from billingInterval via durationPolicy(). When set, it wins over the
   * derived value. This is the SINGLE explicit-TTL knob (the legacy
   * `licenseTtlSeconds` field is retired — it was inert on the issue path).
   *
   * Bound: 1 hour … 95,000,000 s (~1099 days). Note this ceiling is deliberately
   * a bit BELOW the signer's absolute clamp (SAFE_MAX_TTL ≈ 97.4M s, ~1127 days),
   * so a validated override never even reaches the clamp — an admin gets exactly
   * what they set. The full-perpetual case is `billingInterval:'lifetime'`, which
   * derives SAFE_MAX_TTL internally (not via this field). (Phase 3, plan §7 opt B)
   */
  @IsOptional() @IsInt() @Min(3600) @Max(95_000_000)
  ttlOverrideSeconds?: number;

  /**
   * Mark this package as free on the storefront. Coherence is enforced in the
   * SERVICE (isFree ⇒ priceCents=0, billingInterval='once'); it does NOT change
   * which features the npm bundle unlocks. (Phase 3)
   */
  @IsOptional() @IsBoolean()
  isFree?: boolean;

  @IsOptional() @IsBoolean()
  active?: boolean;

  /** Show on the public /pricing storefront (buyable self-serve). Default off. */
  @IsOptional() @IsBoolean()
  publiclyListed?: boolean;

  /** Feature ids to include — must be non-empty; sellability re-checked server-side. */
  @IsArray() @ArrayNotEmpty()
  @IsString({ each: true })
  featureIds!: string[];
}

/** Update: same fields, all optional. */
export class UpdatePackageDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) priceCents?: number;
  @IsOptional() @IsIn(['USD'], { message: 'currency must be USD' }) currency?: string;
  @IsOptional() @IsIn(BILLING_INTERVALS) billingInterval?: (typeof BILLING_INTERVALS)[number];
  @IsOptional() @IsBoolean() domainBound?: boolean;
  /** Domains one licence may bind; 0 = unlimited (§2 security). */
  @IsOptional() @IsInt() @Min(0) @Max(1000) maxDomains?: number;
  /** Distinct installs one licence may serve; 0 = unlimited (§2.4). */
  @IsOptional() @IsInt() @Min(0) @Max(10_000) maxInstalls?: number;
  @IsOptional() @IsInt() @Min(3600) @Max(95_000_000) ttlOverrideSeconds?: number;
  @IsOptional() @IsBoolean() isFree?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() publiclyListed?: boolean;
  @IsOptional() @IsArray() @ArrayNotEmpty() @IsString({ each: true }) featureIds?: string[];
}
