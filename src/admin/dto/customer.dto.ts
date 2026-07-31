import { IsString, IsEmail, IsArray, IsOptional, Length } from 'class-validator';

export class CreateCustomerDto {
  @IsString() @Length(1, 200)
  name!: string;

  @IsEmail()
  email!: string;

  /** Registered domains for domain-bound licenses. */
  @IsOptional() @IsArray() @IsString({ each: true })
  domains?: string[];
}

export class UpdateCustomerDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) domains?: string[];
}
