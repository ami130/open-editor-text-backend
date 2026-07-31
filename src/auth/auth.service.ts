/**
 * auth.service.ts — admin authentication: verify credentials (bcrypt), mint
 * short-lived access tokens + rotating refresh tokens, and re-issue on refresh.
 *
 * Token design:
 *   • access:  { sub, email, perms[], tv, type:'access' }  — short TTL, Bearer.
 *   • refresh: { sub, tv, type:'refresh' }                 — long TTL, cookie.
 * Both carry `tv` (tokenVersion); bumping the user's tokenVersion invalidates
 * all outstanding tokens (logout-everywhere / password change). Refresh tokens
 * are ROTATED — each refresh mints a new pair.
 */
import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { AUTH_CONFIG, AuthConfig } from '../config/auth.config';
import { UserEntity } from './entities/user.entity';
import { SUPER_PERMISSION } from './permission-catalog';

// Pin the signing/verification algorithm — never let a token's header choose it
// (alg-confusion defense-in-depth). HS256 matches the symmetric secret.
const JWT_ALG = 'HS256' as const;

// A bcrypt hash of a fixed dummy string, compared against when the user is
// missing/inactive so login takes the SAME time whether or not the email
// exists (defeats user-enumeration by timing). The cost MUST match the real
// password cost, else the missing-user path is measurably faster and the timing
// defense leaks. Derived per-config at construction time. (L9)

export interface AccessClaims { sub: string; email: string; perms: string[]; tv: number; type: 'access'; }
export interface RefreshClaims { sub: string; tv: number; jti: string; type: 'refresh'; }
export interface TokenPair { accessToken: string; refreshToken: string; }

@Injectable()
export class AuthService {
  /** Dummy hash at the SAME cost as real passwords, so the missing-user compare
   *  takes the same time as a real one (user-enumeration timing defense). (L9) */
  private readonly dummyHash: string;

  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(JwtService) private readonly jwt: JwtService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
  ) {
    this.dummyHash = bcrypt.hashSync('oe-dummy-password-for-constant-time', this.cfg.bcryptRounds);
  }

  /** Hash a plaintext password with the configured bcrypt cost. */
  hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.cfg.bcryptRounds);
  }

  /** Verify credentials → the user (with roles/permissions) or throw 401. */
  async validateCredentials(email: string, password: string): Promise<UserEntity> {
    // passwordHash is select:false — request it explicitly for the check.
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .leftJoinAndSelect('u.roles', 'r')
      .leftJoinAndSelect('r.permissions', 'p')
      .where('u.email = :email', { email: String(email || '').toLowerCase().trim() })
      .getOne();
    // Constant-time: ALWAYS run a bcrypt compare, even when the user is
    // missing/inactive (against a dummy hash), so login timing doesn't reveal
    // whether an email exists (user-enumeration defense). (I5)
    if (!user || !user.active) {
      await bcrypt.compare(String(password || ''), this.dummyHash);
      throw new UnauthorizedException('invalid credentials');
    }
    const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
    if (!ok) throw new UnauthorizedException('invalid credentials');
    return user;
  }

  /**
   * Mint an access+refresh pair AND persist the refresh jti as the user's
   * current one (rotation anchor for reuse detection). Returns the pair.
   */
  async issueTokens(user: UserEntity): Promise<TokenPair> {
    const perms = this.effectivePermissions(user);
    const jti = randomUUID();
    user.refreshTokenId = jti;
    await this.users.update({ id: user.id }, { refreshTokenId: jti });
    const access: AccessClaims = { sub: user.id, email: user.email, perms, tv: user.tokenVersion, type: 'access' };
    const refresh: RefreshClaims = { sub: user.id, tv: user.tokenVersion, jti, type: 'refresh' };
    return {
      accessToken: this.jwt.sign(access, { secret: this.cfg.accessSecret, algorithm: JWT_ALG, expiresIn: this.cfg.accessTtl }),
      refreshToken: this.jwt.sign(refresh, { secret: this.cfg.refreshSecret, algorithm: JWT_ALG, expiresIn: this.cfg.refreshTtl }),
    };
  }

  /** Verify an access token's SIGNATURE/expiry/type only (no DB). */
  verifyAccess(token: string): AccessClaims {
    try {
      const c = this.jwt.verify<AccessClaims>(token, { secret: this.cfg.accessSecret, algorithms: [JWT_ALG] });
      if (c.type !== 'access') throw new Error('wrong type');
      return c;
    } catch {
      throw new UnauthorizedException('invalid or expired access token');
    }
  }

  /**
   * Verify an access token AND that the session is still valid: the user must
   * still exist, be active, and have the matching tokenVersion. This makes
   * logout / password-change / deactivation kill outstanding ACCESS tokens on
   * the very next request (closes the "valid-until-exp" window). (C1)
   */
  async verifyActiveAccess(token: string): Promise<AccessClaims> {
    const claims = this.verifyAccess(token);
    const user = await this.users.findOne({ where: { id: claims.sub } });
    if (!user || !user.active) throw new UnauthorizedException('session no longer valid');
    if (user.tokenVersion !== claims.tv) throw new UnauthorizedException('session revoked');
    return claims;
  }

  /**
   * Exchange a refresh token for a fresh pair (rotation) with REUSE DETECTION:
   * the presented jti must equal the user's current refreshTokenId. A stale jti
   * = an already-rotated (replayed/stolen) token → we revoke the whole family
   * (bump tokenVersion) and reject. (I3)
   */
  async refresh(refreshToken: string): Promise<{ pair: TokenPair; user: UserEntity }> {
    let claims: RefreshClaims;
    try {
      claims = this.jwt.verify<RefreshClaims>(refreshToken, { secret: this.cfg.refreshSecret, algorithms: [JWT_ALG] });
      if (claims.type !== 'refresh') throw new Error('wrong type');
    } catch {
      throw new UnauthorizedException('invalid or expired refresh token');
    }
    const user = await this.users.findOne({ where: { id: claims.sub } });
    if (!user || !user.active) throw new UnauthorizedException('user no longer valid');
    if (user.tokenVersion !== claims.tv) throw new UnauthorizedException('session revoked');
    if (!claims.jti || user.refreshTokenId !== claims.jti) {
      // Reuse of an already-rotated refresh token → treat as compromise.
      await this.bumpTokenVersion(user.id);
      throw new UnauthorizedException('refresh token reuse detected — session revoked');
    }
    const pair = await this.issueTokens(user); // rotates the jti
    return { pair, user };
  }

  /** Invalidate all of a user's tokens (logout-everywhere / password change). */
  async bumpTokenVersion(userId: string): Promise<void> {
    await this.users.increment({ id: userId }, 'tokenVersion', 1);
    await this.users.update({ id: userId }, { refreshTokenId: '' });
  }

  /** Effective permission keys; the wildcard '*' collapses to just ['*']. */
  private effectivePermissions(user: UserEntity): string[] {
    const keys = user.permissionKeys();
    return keys.includes(SUPER_PERMISSION) ? [SUPER_PERMISSION] : keys;
  }
}
