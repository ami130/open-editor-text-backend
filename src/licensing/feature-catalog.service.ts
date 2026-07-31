/**
 * feature-catalog.service.ts — keeps the `features` DB table in sync with the
 * vendored FEATURE_CATALOG on boot (upsert by id; mark deprecated). This is the
 * list the admin picks from when composing packages, so it must reflect the
 * engine. Idempotent — safe to run on every start.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { FeatureEntity } from './entities/feature.entity';
import { FEATURE_CATALOG } from './feature-catalog';

@Injectable()
export class FeatureCatalogService implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.sync();
  }

  /**
   * Sync the vendored catalog into the `features` table, ATOMICALLY (single
   * transaction), and RECONCILE removals: any DB feature no longer in the
   * catalog is marked deprecated + non-sellable rather than left stale/pickable
   * (I6). Idempotent. Persists `sellable` so the flag isn't only in-memory (#8).
   * Returns the count of catalog features.
   */
  async sync(): Promise<number> {
    await this.dataSource.transaction(async (mgr) => {
      const repo = mgr.getRepository(FeatureEntity);
      const catalogIds = new Set(FEATURE_CATALOG.map((f) => f.id));
      // Upsert every catalog feature.
      for (const f of FEATURE_CATALOG) {
        await repo.save(repo.create({
          id: f.id,
          title: f.title,
          group: f.group,
          kind: f.kind,
          deprecated: !!f.deprecated,
          sellable: !!f.sellable && !f.deprecated,
        }));
      }
      // Reap: features in the DB but no longer in the catalog → retire them.
      const existing = await repo.find();
      for (const row of existing) {
        if (!catalogIds.has(row.id) && (!row.deprecated || row.sellable)) {
          row.deprecated = true;
          row.sellable = false;
          await repo.save(row);
        }
      }
    });
    return FEATURE_CATALOG.length;
  }

  /** Features an admin may put in a package (persisted sellable flag). */
  async sellable(): Promise<FeatureEntity[]> {
    return this.dataSource.getRepository(FeatureEntity).find({ where: { sellable: true } });
  }
}
