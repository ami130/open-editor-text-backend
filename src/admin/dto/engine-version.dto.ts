/**
 * engine-version.dto.ts — admin request shapes for the engine version registry
 * (delivery §1.2).
 *
 * The publish payload mirrors exactly what the engine's build emits in
 * dist/delivery/manifest.json, so publishing is a copy of that file rather than
 * hand-assembled data — the fewer values a human retypes, the fewer ways the
 * registry can disagree with the actual bytes.
 */
import {
  IsArray, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max, ArrayNotEmpty,
} from 'class-validator';

export class PublishEngineBuildDto {
  /** Semver of the build, e.g. "1.3.0". */
  @IsString()
  @Matches(/^\d+\.\d+\.\d+(-[\w.]+)?$/, { message: 'version must be semver, e.g. 1.3.0' })
  version!: string;

  @IsIn(['free', 'premium'])
  plan!: string;

  /**
   * Feature ids this build supports — the right-hand side of the T14
   * intersection. Rejected when empty: a build with no manifest would grant
   * every session zero features, silently.
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  supportedFeatures!: string[];

  /** Object-storage key (T21). */
  @IsString()
  @MaxLength(500)
  bundleKey!: string;

  /** Content hash of the exact artifact — also what the loader verifies (§1.5). */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/i, { message: 'bundleSha256 must be a 64-char hex SHA-256' })
  bundleSha256!: string;

  @IsInt()
  @Min(1)
  bundleBytes!: number;

  /** New builds start on `internal` unless stated — never straight to stable. */
  @IsOptional()
  @IsIn(['internal', 'beta', 'stable'])
  channel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /**
   * The bundle's actual bytes, base64-encoded (§1.4a).
   *
   * Base64 in the JSON body rather than a multipart upload: the publish payload
   * is already this manifest, so keeping it one document means one atomic
   * request — either the whole build lands or none of it does. It costs ~33%
   * over the wire, which is irrelevant for an admin operation performed a few
   * times per release.
   *
   * Optional so metadata-only publishes remain possible, but a row published
   * without bytes cannot be downloaded — the engine endpoint will 404 it.
   */
  @IsOptional()
  @IsString()
  bundleBase64?: string;
}

/**
 * Re-upload the bytes of an already-published build (§1.4a repair path).
 *
 * No hash field: the digest is whatever the registry row already records, and
 * the service verifies these bytes against it. Accepting a hash here would
 * invite a caller to "correct" the recorded one, which is exactly the
 * immutability violation this endpoint must not permit.
 */
export class RestoreBundleDto {
  @IsString()
  bundleBase64!: string;
}

export class PromoteVersionDto {
  @IsIn(['internal', 'beta', 'stable'])
  channel!: string;
}

export class SetDefaultDto {
  /**
   * Scope: 'global', or `channel:<name>`. A channel scope overrides global for
   * callers who opted into that channel.
   */
  @IsString()
  @Matches(/^(global|channel:(internal|beta|stable))$/, {
    message: 'scope must be "global" or "channel:internal|beta|stable"',
  })
  scope!: string;

  @IsString()
  @Matches(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
  version!: string;

  /** Why this pointer moved — kept in history for the incident write-up. */
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class RetireVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}


/**
 * §2.8 — a rollback request.
 *
 * NOTE: there is deliberately NO `version` field. The target comes from the
 * recorded history, not from a human typing a version number during an
 * incident, which is the realistic way a rollback goes wrong.
 */
export class RollbackDto {
  @IsString()
  @Matches(/^(global|channel:(internal|beta|stable))$/, {
    message: 'scope must be "global" or "channel:internal|beta|stable"',
  })
  scope!: string;

  /** Why — recorded in history. Strongly encouraged, not enforced: an incident
   *  must never be blocked by a validation error on a description. */
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}


/** §2.7 — start or ramp a gradual release. */
export class StartCanaryDto {
  @IsString()
  @Matches(/^(global|channel:(internal|beta|stable))$/, {
    message: 'scope must be "global" or "channel:internal|beta|stable"',
  })
  scope!: string;

  @IsString() @MaxLength(32)
  version!: string;

  /**
   * 0-100. Also clamped server-side: a typo of 1000 in an admin form must never
   * become a full rollout to every customer at once.
   */
  @IsInt() @Min(0) @Max(100)
  percent!: number;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** §2.7 — halt a gradual release. */
export class HaltCanaryDto {
  @IsString()
  @Matches(/^(global|channel:(internal|beta|stable))$/, {
    message: 'scope must be "global" or "channel:internal|beta|stable"',
  })
  scope!: string;
}
