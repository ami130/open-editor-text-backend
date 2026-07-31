/**
 * customer.entity.ts — a buyer who owns one or more licenses. Domains here are
 * the sites their licenses may be bound to.
 */
import {
  Entity, PrimaryGeneratedColumn, Column, OneToMany, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { LicenseEntity } from './license.entity';

@Entity('customers')
export class CustomerEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 200, unique: true })
  email!: string;

  /**
   * Registered site domains, used for domain-bound licenses. Stored as JSON
   * text. No column DEFAULT — MySQL can't set a literal default on TEXT; the
   * app always supplies the array via create()/save(), and the initializer
   * below guarantees it's never undefined. (I2)
   */
  @Column({ type: 'simple-json' })
  domains!: string[];

  /**
   * Single-use nonce for the self-serve portal magic-link (Phase 4). Rotated
   * every time a link is issued AND when one is consumed, so an emailed link
   * works exactly once and a replayed/older link fails the nonce check. Empty =
   * no outstanding link. Never exposed by any endpoint. (Mirrors the admin
   * user's refreshTokenId single-use pattern.) select:false — never leaves the DB.
   */
  @Column({ type: 'varchar', length: 64, default: '', select: false })
  magicNonce!: string;

  /**
   * Portal session epoch (Phase 4c hardening / audit M4). Every issued customer
   * session token embeds the epoch current at issue; a logout / forced-revoke
   * increments it, so all outstanding sessions for this customer stop verifying
   * immediately (the stateless JWT gains a server-side kill switch, mirroring the
   * admin tokenVersion). Checked in the customer auth guard.
   */
  @Column({ type: 'int', default: 0 })
  sessionEpoch!: number;

  @OneToMany(() => LicenseEntity, (l) => l.customer)
  licenses?: LicenseEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
