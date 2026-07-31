/**
 * refresh.dto.ts — body for the public refresh endpoint (Phase 4c).
 */
import { IsString, Length } from 'class-validator';

export class RefreshTokenDto {
  /** The current (near-expiry) signed license token to refresh. */
  @IsString() @Length(10, 8192)
  token!: string;
}
