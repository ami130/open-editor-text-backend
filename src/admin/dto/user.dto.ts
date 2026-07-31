import { IsString, IsEmail, IsArray, IsOptional, IsBoolean, Length, MinLength } from 'class-validator';

/** Create an admin (staff) user: credentials + the roles they hold. */
export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsOptional() @IsString() @Length(0, 120)
  name?: string;

  // Minimum length only — full strength policy is a later concern; bcrypt-hashed
  // by the service, never stored plaintext.
  @IsString() @MinLength(8)
  password!: string;

  /** Role ids to assign. */
  @IsOptional() @IsArray() @IsString({ each: true })
  roleIds?: string[];
}

/** Update an admin user: rename, toggle active, reassign roles, and/or reset
 *  the password. All fields optional; omitted fields are unchanged. */
export class UpdateUserDto {
  @IsOptional() @IsString() @Length(0, 120) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) roleIds?: string[];
  @IsOptional() @IsString() @MinLength(8) password?: string;
}
