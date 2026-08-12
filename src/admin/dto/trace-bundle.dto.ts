import { IsString, Length } from 'class-validator';

/**
 * §2.5 — a suspect bundle to attribute.
 *
 * Accepts either the whole file or just the fragment containing the marker, so
 * an investigator does not have to paste ~700 KB to identify a leak. The upper
 * bound is generous enough for a full premium bundle and still bounded, since
 * this is an authenticated but human-driven endpoint.
 */
export class TraceBundleDto {
  @IsString() @Length(1, 8_000_000)
  content!: string;
}
