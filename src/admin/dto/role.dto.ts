import { IsString, IsArray, IsOptional, Length } from 'class-validator';

/** Create a role: a name + a set of permission keys (validated against the
 *  catalog in the service, not here — keeps the error message specific). */
export class CreateRoleDto {
  @IsString() @Length(1, 60)
  name!: string;

  @IsOptional() @IsString() @Length(0, 200)
  description?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  permissions?: string[];
}

/** Update a role: any subset of fields. `permissions`, when present, REPLACES
 *  the role's permission set (not a merge) — the UI sends the full desired set. */
export class UpdateRoleDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsString() @Length(0, 200) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
}
