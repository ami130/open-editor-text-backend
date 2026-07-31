/**
 * refresh-event.entity.ts — a persisted record of ONE license-refresh attempt
 * (Phase 5b). Phase 4's RefreshLogService only wrote a Logger line; this makes
 * the (licId, ip, origin, outcome, when) tuple QUERYABLE, which is the raw
 * material the Phase-5c anti-sharing detector needs ("one key from many
 * domains/IPs in a window").
 *
 * NOT a security credential — it never stores the token. Rows are pruned on a
 * rolling window (RefreshLogService) so the table stays bounded.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn,
} from 'typeorm';

@Entity('refresh_events')
// Composite index for the detector's hot query: "events for this licId since T".
@Index(['licId', 'createdAt'])
export class RefreshEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The license id the refresh was for. Empty when the token didn't resolve
   *  (garbage/unknown) — such rows are noise for per-key analysis but useful for
   *  raw volume/abuse signal. Indexed (composite above) for the detector. */
  @Column({ type: 'varchar', length: 64, default: '' })
  licId!: string;

  /** Client IP (from req.ip; trust proxy is set). Empty if unavailable. */
  @Column({ type: 'varchar', length: 64, default: '' })
  ip!: string;

  /** Request Origin header (the calling site). Empty if absent. Bounded length —
   *  an Origin is a scheme+host, never long; oversize is truncated on write. */
  @Column({ type: 'varchar', length: 255, default: '' })
  origin!: string;

  /** The refresh outcome: refreshed | refused | term-ended | rate-limited | origin-blocked. */
  @Column({ type: 'varchar', length: 16, default: '' })
  outcome!: string;

  @Index()
  @CreateDateColumn()
  createdAt!: Date;
}
