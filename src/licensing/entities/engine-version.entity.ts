/**
 * engine-version.entity.ts — one PUBLISHED build of the editor engine
 * (delivery execution plan §1.2).
 *
 * THREE INDEPENDENT AXES — kept deliberately separate:
 *
 *   version   v1.2.0, v1.3.0        which build
 *   plan      free, premium         which features that build contains
 *   channel   internal/beta/stable  who is allowed to receive it
 *
 * Version is NOT tied to plan. If it were ("Pro = v1.3.0"), a single Pro
 * customer could never be rolled back without changing their plan — a coupling
 * that is cheap to avoid now and expensive to unpick later.
 *
 * One row = one (version, plan) pair, so v1.3.0 produces two rows: free and
 * premium. A version is only RESOLVABLE once every active plan has a row
 * (enforced at publish time — see EngineVersionService), because a Pro customer
 * resolving to a version with no Pro build has nothing to serve.
 *
 * IMMUTABILITY: a published row is never edited. New content = new version.
 * Integrity hashes, per-licence watermarking, and rollback all assume the bytes
 * behind a given (version, plan) never change.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/** Who may receive this build. Promotion path: internal → beta → stable. */
export type EngineChannel = 'internal' | 'beta' | 'stable';

/** Lifecycle. `retired` still serves existing pins but is never resolved as a default. */
export type EngineVersionStatus = 'published' | 'retired';

@Entity('engine_versions')
@Index(['version', 'plan'], { unique: true })
export class EngineVersionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Semver of the engine build, e.g. "1.2.0". Not prefixed with "v". */
  @Column({ type: 'varchar', length: 32 })
  version!: string;

  /** Which bundle this row describes: 'free' | 'premium'. */
  @Column({ type: 'varchar', length: 16 })
  plan!: string;

  /**
   * Promotion stage. Kept per-row (not per-version) so a plan's build can be
   * promoted independently if ever needed — but in normal operation both rows
   * for a version move together.
   */
  @Column({ type: 'varchar', length: 16, default: 'internal' })
  channel!: EngineChannel;

  /**
   * Feature ids this specific build supports, produced at build time by the
   * engine's scripts/build-manifest.mjs.
   *
   * THIS IS THE RIGHT-HAND SIDE OF THE T14 INTERSECTION:
   *
   *     granted = package.features ∩ engineVersion.supportedFeatures
   *
   * Without it, a licence snapshotted in January silently never receives a
   * feature added in March (customer paid, gets nothing), and a customer pinned
   * to an old version receives a token promising features their build does not
   * have. Both fail silently — hence storing it explicitly per build.
   */
  @Column({ type: 'simple-json' })
  supportedFeatures!: string[];

  /** Object-storage key for the bundle (T21). Bytes never pass through the app server. */
  @Column({ type: 'varchar', length: 500 })
  bundleKey!: string;

  /**
   * SHA-256 of the bundle. Sent to the loader in the session response so it can
   * verify what it received BEFORE decoding — catching truncated downloads,
   * mangling proxies, and poisoned caches (§1.5).
   */
  @Column({ type: 'varchar', length: 64 })
  bundleSha256!: string;

  /** Bundle size in bytes — for bandwidth modelling and sanity checks. */
  @Column({ type: 'int', default: 0 })
  bundleBytes!: number;

  /**
   * 'published' | 'retired'. Retired builds still serve customers pinned to
   * them; they simply stop being eligible as a default. A version is NEVER
   * deleted while any licence pins it — deletion would break those customers
   * with no recovery path.
   */
  @Column({ type: 'varchar', length: 16, default: 'published' })
  status!: EngineVersionStatus;

  /** Admin note — why this version exists, or why it was retired. */
  @Column({ type: 'varchar', length: 500, default: '' })
  notes!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
