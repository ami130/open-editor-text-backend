import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

/** Login credentials. Validated by the global ValidationPipe. */
export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}
