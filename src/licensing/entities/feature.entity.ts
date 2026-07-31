/**
 * feature.entity.ts — the catalog of sellable engine features.
 *
 * The rows are SYNCED from the editor engine's feature registry (see
 * FeatureCatalogService) — never hand-typed — so the admin's pick-list can
 * never drift from what the engine actually supports. `id` IS the registry
 * feature id (e.g. "seo", "ai.translate").
 */
import { Entity, PrimaryColumn, Column, ManyToMany } from 'typeorm';
import { PackageEntity } from './package.entity';

@Entity('features')
export class FeatureEntity {
  /** The engine feature id, e.g. "seo", "ai.translate". */
  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  /** Admin-tree grouping (e.g. 'Text formatting', 'Lists', 'AI'). */
  @Column({ type: 'varchar', length: 60, default: 'General' })
  group!: string;

  /** 'core' | 'plugin' | 'premium' — how the feature is gated/labelled. */
  @Column({ type: 'varchar', length: 16, default: 'premium' })
  kind!: string;

  /** Deprecated features stay in the catalog but shouldn't be sold. */
  @Column({ type: 'boolean', default: false })
  deprecated!: boolean;

  /**
   * Whether this feature may be composed into a sellable package. Persisted (not
   * just derived in memory) so any consumer reading the `features` table — admin
   * UI, reports — can tell a sellable feature from an internal/test one (e.g.
   * dev.smoke) without needing the vendored catalog file.
   */
  @Column({ type: 'boolean', default: true })
  sellable!: boolean;

  @ManyToMany(() => PackageEntity, (pkg) => pkg.features)
  packages?: PackageEntity[];
}
