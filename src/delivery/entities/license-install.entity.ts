/**
 * license-install.entity.ts — one row per DISTINCT browser install that has
 * used a given licence (§2.4, install-ID activation).
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Domain binding (T11) locks a licence to the domains it was sold for, but
 * carries a deliberate localhost exemption so a developer can build without
 * owning the customer's domain. That exemption is unbounded: one key posted in
 * a group chat works on unlimited `localhost` machines forever, and the domain
 * lock never fires because none of them are on a domain.
 *
 * Counting DISTINCT INSTALLS is what closes that. One customer on a laptop, a
 * desktop and CI is normal; one key on thirty machines is not.
 *
 * ─── WHY A TABLE HERE, WHEN T17 SAYS "NO WRITE PER SESSION" ─────────────────
 * T17's concern is the ANONYMOUS free path: thousands of end-users per customer
 * loading the editor on every page view. That path is untouched — no licence,
 * no row, ever. Rows exist only for LICENSED callers, and only the FIRST time a
 * given install presents that key. A returning install is a read (covered by
 * the unique index), not a write. So volume is bounded by
 * `licences × installs-per-licence`, which is the number we are capping — not
 * by page views.
 *
 * ─── NOT A PERSON IDENTIFIER ────────────────────────────────────────────────
 * `installId` is a random value minted client-side with no derivation from
 * anything about the device or user (see loader/src/install-id.js). It
 * identifies a browser profile, not a human. Clearing site data mints a new one
 * — which is why enforcement is ADDITIVE and never revokes a paying customer
 * (see LicenseInstallService).
 */
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('license_installs')
// One row per (licence, install). The UNIQUE constraint is the enforcement
// primitive itself: it makes "have I seen this install before?" a single
// indexed lookup, and makes a duplicate insert impossible even under the race
// of two tabs opening a session simultaneously.
@Index(['licId', 'installId'], { unique: true })
export class LicenseInstallEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The licence this install activated against. */
  @Column({ type: 'varchar', length: 64 })
  licId!: string;

  /** The loader-minted install id (`oe_` + 32 hex). Bounded to match the DTO cap. */
  @Column({ type: 'varchar', length: 128 })
  installId!: string;

  /**
   * Most recent origin this install called from. Support/forensics only — it
   * answers "where is this seat actually being used?" when a customer disputes
   * a cap. Never used for entitlement; the domain gate is separate (T11).
   */
  @Column({ type: 'varchar', length: 255, default: '' })
  origin!: string;

  /**
   * Set when an install was seen but REFUSED because the cap was already full.
   * Kept rather than discarded so the cap is auditable: you can see exactly
   * which installs were turned away and when, instead of a silent denial.
   */
  @Column({ type: 'boolean', default: false })
  blocked!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  /** Touched on each sighting, so an idle seat is distinguishable from a live one. */
  @UpdateDateColumn()
  lastSeenAt!: Date;
}
