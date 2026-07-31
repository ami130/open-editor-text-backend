/**
 * portal.dto.ts — request shapes for the self-serve customer portal (Phase 4a).
 */
import { IsString, IsEmail, Length } from 'class-validator';

export class RequestLinkDto {
  /** The customer's email. We never reveal whether it maps to a customer. */
  @IsEmail()
  email!: string;
}

export class VerifyLinkDto {
  /** The one-time magic-link token from the emailed URL. */
  @IsString() @Length(10, 4096)
  token!: string;
}
