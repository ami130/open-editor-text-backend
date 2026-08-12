/**
 * engine-admin.controller.ts — the admin surface for runtime engine delivery
 * (execution plan §1.2).
 *
 * Without this, versions could only be published by calling the service from
 * code — the registry existed but nobody could operate it.
 *
 * PERMISSIONS ARE SPLIT DELIBERATELY. Publishing a build is routine and low
 * risk (nothing resolves to an `internal` build). Moving the DEFAULT pointer is
 * what every customer actually receives, and is also the rollback control — so
 * `engine.default` is a separate, higher-trust permission than `engine.publish`.
 *
 * Every mutation is audited: the acting admin is logged with the change, so
 * "who moved the default at 3am" is answerable.
 */
import {
  Controller, Get, Post, Patch, Param, Query, Body, Logger,
} from '@nestjs/common';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import type { AccessClaims } from '../auth/auth.service';
import { EngineVersionService } from '../licensing/engine-version.service';
import { EngineChannel } from '../licensing/entities/engine-version.entity';
import {
  PublishEngineBuildDto, PromoteVersionDto, SetDefaultDto, RetireVersionDto,
  RestoreBundleDto, RollbackDto,
} from './dto/engine-version.dto';

@Controller('admin/engine')
export class EngineAdminController {
  private readonly log = new Logger(EngineAdminController.name);

  constructor(private readonly engine: EngineVersionService) {}

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * Every build, annotated with `bytesPresent`.
   *
   * Rows and bytes live in different places and can drift — most commonly a
   * redeploy onto an ephemeral filesystem, which keeps the database rows and
   * loses the bundles. A build with `bytesPresent: false` cannot be promoted or
   * defaulted (isComplete refuses), and needs its bytes restored below.
   */
  @Get('versions')
  @RequirePermissions('engine.read')
  listVersions() {
    return this.engine.listVersionsWithHealth();
  }

  @Get('defaults')
  @RequirePermissions('engine.read')
  listDefaults() {
    return this.engine.listDefaults();
  }

  /**
   * Is this version safe to promote or default to? Surfaces the
   * complete-matrix check so the admin UI can disable those actions rather
   * than letting the request fail.
   */
  @Get('versions/:version/status')
  @RequirePermissions('engine.read')
  async versionStatus(@Param('version') version: string) {
    return this.engine.isComplete(version);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Register one built bundle. The payload mirrors the engine build's
   * dist/delivery/manifest.json, so the recorded hash always describes the
   * bytes that were actually built.
   */
  @Post('versions')
  @RequirePermissions('engine.publish')
  async publish(@Body() dto: PublishEngineBuildDto, @CurrentUser() user: AccessClaims) {
    const row = await this.engine.publishBuild({
      version: dto.version,
      plan: dto.plan,
      supportedFeatures: dto.supportedFeatures,
      bundleKey: dto.bundleKey,
      bundleSha256: dto.bundleSha256,
      bundleBytes: dto.bundleBytes,
      channel: (dto.channel as EngineChannel) ?? 'internal',
      notes: dto.notes ?? '',
      // Bytes are stored BEFORE the row commits, and their hash re-verified
      // against the manifest (§1.4a). A publish without bytes is allowed but
      // produces an undownloadable row, so it is logged distinctly below.
      bytes: dto.bundleBase64 ? Buffer.from(dto.bundleBase64, 'base64') : undefined,
    });
    this.log.log(
      `published ${dto.version} (${dto.plan}) by ${user?.sub ?? 'unknown'}`
      + (dto.bundleBase64 ? '' : ' — METADATA ONLY, no bytes stored: this bundle cannot be served'),
    );
    return row;
  }

  /**
   * Re-upload the bytes of an already-published build whose bundle went missing
   * (§1.4a) — typically after a redeploy onto an ephemeral filesystem.
   *
   * NOT an edit: the bytes must hash to the digest the row already records, so
   * the only possible result is restoring the original bundle. Anything else is
   * refused. Uses `engine.publish` because it is the same act — putting the
   * bytes for a build into storage — not a rollout decision.
   */
  @Post('versions/:version/:plan/restore')
  @RequirePermissions('engine.publish')
  async restore(
    @Param('version') version: string,
    @Param('plan') plan: string,
    @Body() dto: RestoreBundleDto,
    @CurrentUser() user: AccessClaims,
  ) {
    const result = await this.engine.restoreBundleBytes(
      version, plan, Buffer.from(dto.bundleBase64, 'base64'),
    );
    this.log.log(
      `restore ${version} (${plan}) by ${user?.sub ?? 'unknown'}: `
      + (result.restored ? 'bytes re-uploaded' : 'already present, no-op'),
    );
    return result;
  }

  @Patch('versions/:version/channel')
  @RequirePermissions('engine.promote')
  async promote(
    @Param('version') version: string,
    @Body() dto: PromoteVersionDto,
    @CurrentUser() user: AccessClaims,
  ) {
    const rows = await this.engine.promote(version, dto.channel as EngineChannel);
    this.log.log(`promoted ${version} → ${dto.channel} by ${user?.sub ?? 'unknown'}`);
    return rows;
  }

  /**
   * Point a scope at a version. **This is also the rollback control** — moving
   * `global` back to an earlier version undoes a bad release in seconds without
   * touching a single published bundle.
   *
   * Customers with an explicit pin are deliberately unaffected: a pin outranks
   * every default, which is exactly what makes pinning trustworthy.
   */
  /**
   * §2.8 — ROLL BACK a scope to its previous version, in ONE call.
   *
   * Deliberately takes no version argument. At 03:00 the realistic failure is
   * naming the wrong version under pressure, so the safe operation is the one
   * that cannot be given a wrong value: the target is read from the recorded
   * history, not typed by a human mid-incident.
   *
   * Uses engine.default permission — it is the same authority as a release,
   * because it is the same action pointed backwards.
   */
  @Post('rollback')
  @RequirePermissions('engine.default')
  async rollback(@Body() dto: RollbackDto, @CurrentUser() user: AccessClaims) {
    const result = await this.engine.rollback(dto.scope, {
      actor: user?.sub ?? '',
      reason: dto.reason ?? '',
    });
    // WARN, not LOG: a rollback is an incident signal and should stand out in
    // whatever aggregates these lines.
    this.log.warn(
      `ROLLBACK: ${result.scope} ${result.from || '(unset)'} → ${result.to} `
      + `by ${user?.sub ?? 'unknown'}${dto.reason ? ` — ${dto.reason}` : ''}`,
    );
    return result;
  }

  /** §2.8 — what changed, when, and by whom. The rollback target comes from here. */
  @Get('defaults/history')
  @RequirePermissions('engine.read')
  history(@Query('scope') scope?: string, @Query('limit') limit?: string) {
    return this.engine.defaultHistory(scope, Number(limit) || 50);
  }

  @Post('defaults')
  @RequirePermissions('engine.default')
  async setDefault(@Body() dto: SetDefaultDto, @CurrentUser() user: AccessClaims) {
    const row = await this.engine.setDefault(dto.scope, dto.version, {
      actor: user?.sub ?? '',
      reason: dto.reason ?? '',
    });
    this.log.warn(
      `DEFAULT CHANGED: ${dto.scope} → ${dto.version} by ${user?.sub ?? 'unknown'} `
      + '(this is what new sessions now receive)',
    );
    return row;
  }

  /**
   * Retire a version: no new resolutions, but customers PINNED to it keep
   * working. Never a delete — deleting would break those customers with no
   * recovery path.
   */
  @Patch('versions/:version/retire')
  @RequirePermissions('engine.retire')
  async retire(
    @Param('version') version: string,
    @Body() dto: RetireVersionDto,
    @CurrentUser() user: AccessClaims,
  ) {
    const rows = await this.engine.retire(version, dto.notes ?? '');
    this.log.log(`retired ${version} by ${user?.sub ?? 'unknown'}`);
    return rows;
  }
}
