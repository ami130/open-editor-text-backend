import { IsString, IsEmail, IsArray, IsOptional, Length, IsUUID } from 'class-validator';

/** Public self-serve checkout request. NOTE: there is deliberately NO price/
 *  amount field — the server takes the price from the DB package. */
export class CreateCheckoutDto {
  // Package ids are UUID PKs — validate as UUID (same as IssueLicenseDto) so a
  // malformed id is rejected at the boundary rather than reaching the DB lookup.
  @IsUUID()
  packageId!: string;

  @IsEmail()
  email!: string;

  @IsOptional() @IsString() @Length(0, 200)
  name?: string;

  /** Domains for a domain-bound package (required by the service when bound). */
  @IsOptional() @IsArray() @IsString({ each: true })
  domains?: string[];
}
