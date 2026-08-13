/**
 * default-package.entity.ts — which package an UNLICENSED visitor receives
 * (Stage 2a of the dynamic-packages plan).
 *
 * ─── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * Today an anonymous session resolves to the `'*'` sentinel: "everything this
 * build happens to support". So what "free" contains is a property of HOW THE
 * BUNDLE WAS COMPILED, not something an admin can change. Removing a feature
 * from the free tier requires a developer and a rebuild.
 *
 * This makes it data: an admin composes a package, designates it, and every
 * unlicensed visitor receives exactly that — no deploy.
 *
 * ─── WHY A TABLE AND NOT A COLUMN ON `packages` ─────────────────────────────
 * A boolean column (`isDefault`) permits two rows to be true at once, and then
 * the answer to "what does a free user get?" depends on row order. A separate
 * table with a FIXED PRIMARY KEY makes "exactly one" structural rather than
 * something enforced by careful writing.
 *
 * Not reusing `isFree`: that is a STOREFRONT LABEL (this plan is offered at no
 * cost) and several packages may legitimately carry it. It never participated
 * in resolution, and overloading it would silently couple pricing copy to what
 * every anonymous user on the internet receives.
 */
import {
  Entity, PrimaryColumn, Column, UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { PackageEntity } from './package.entity';

/**
 * The single row's id. A fixed key is the enforcement: there can only ever be
 * one designation, because there can only ever be one row.
 */
export const DEFAULT_PACKAGE_ID = 'anonymous';

@Entity('default_packages')
export class DefaultPackageEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id!: string;

  /** The designated package. */
  @Column({ type: 'varchar', length: 36 })
  packageId!: string;

  @ManyToOne(() => PackageEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'packageId' })
  package!: PackageEntity | null;

  /** Who last changed it — this decides what every anonymous user receives. */
  @Column({ type: 'varchar', length: 128, default: '' })
  actor!: string;

  @Column({ type: 'varchar', length: 500, default: '' })
  reason!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
