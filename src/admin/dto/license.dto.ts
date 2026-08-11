import {
  IsBoolean, IsString, IsOptional, IsArray, IsInt, Min, Max, IsUUID } from 'class-validator';

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
