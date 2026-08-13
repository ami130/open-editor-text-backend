import { IsString, IsOptional, MaxLength, IsUUID } from 'class-validator';

/**
 * Stage 2a — designate the package unlicensed visitors receive.
 *
 * The most consequential admin action there is: it decides what every
 * anonymous editor on the internet can do. `reason` is recorded so the change
 * is attributable rather than mysterious.
 */
export class SetDefaultPackageDto {
  @IsUUID()
  packageId!: string;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}
