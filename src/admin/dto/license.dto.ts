import {
  IsBoolean, IsString, IsOptional, IsArray, IsInt, Min, Max, IsUUID, IsIn,
  Length } from 'class-validator';

export class IssueLicenseDto {
  @IsUUID()
  customerId!: string;

  @IsUUID()
  packageId!: string;

  /** Override the customer's domains for this license (optional). */
  @IsOptional() @IsArray() @IsString({ each: true })
  domains?: string[];

  @IsOptional() @IsInt() @Min(3600) @Max(95_000_000)
  ttlSeconds?: number;

  /**
   * Issue this as a SANDBOX licence (§1.8): real entitlements, no commercial
   * meaning. For staging validation and support reproductions, so they never
   * count as revenue and can be swept before a billing reconciliation.
   *
   * Deliberately does NOT change what is granted — staging must rehearse the
   * real premium path exactly, or it stops being a rehearsal.
   */
  @IsOptional() @IsBoolean()
  isTest?: boolean;
}

export class RenewLicenseDto {
  @IsOptional() @IsInt() @Min(3600) @Max(95_000_000)
  ttlSeconds?: number;
}

/**
 * Change which engine BUILD one licence receives (§1.2).
 *
 * The resolution chain is `pin → override → channel default → global default`.
 * These columns were already read by session resolution but had no write path,
 * so moving a single customer required database access.
 *
 * Every field is optional: omit to leave alone, send `''` to clear. Clearing a
 * pin or override means "fall through to the next step in the chain".
 */
export class SetLicenseDeliveryDto {
  /** Opt-in release channel. Leaving beta does NOT auto-downgrade (T15). */
  @IsOptional() @IsIn(['stable', 'beta', 'internal'])
  channel?: string;

  /**
   * The customer's ABSOLUTE version pin — never moved by a new default, a
   * channel promotion, a canary, or a rollback. Pinning is a promise.
   */
  @IsOptional() @IsString() @Length(0, 32)
  pinnedVersion?: string;

  /** Admin "switch this one customer" — e.g. off a bad build. */
  @IsOptional() @IsString() @Length(0, 32)
  overrideVersion?: string;

  /** MANDATORY when setting an override — enforced in the service, because an
   *  unexplained override is impossible to review later. */
  @IsOptional() @IsString() @Length(0, 300)
  overrideReason?: string;

  /** Unix seconds at which the override should be revisited; 0 = never set. */
  @IsOptional() @IsInt() @Min(0)
  overrideReviewAt?: number;
}
