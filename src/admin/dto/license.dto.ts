import { IsString, IsOptional, IsArray, IsInt, Min, Max, IsUUID } from 'class-validator';

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
}

export class RenewLicenseDto {
  @IsOptional() @IsInt() @Min(3600) @Max(95_000_000)
  ttlSeconds?: number;
}
