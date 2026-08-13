/**
 * reset-admin-password.ts — recover a lost admin password.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * There was NO way to recover a lost admin password. `SEED_ADMIN_PASSWORD`
 * only creates the user on first boot — seed.service.ts does
 * `if (existing) return;` — so changing it later does nothing, and the real
 * password lives only as a bcrypt hash in the database.
 *
 * The only route back in was deleting the admin row by hand in a database
 * console and redeploying to let the seed recreate it. That is dangerous to
 * teach (one typo away from deleting the wrong row), needs direct database
 * access not everyone has, and it destroys the user's roles and audit history
 * rather than just changing a password.
 *
 * Written after hitting exactly that during a live deploy.
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *   ADMIN_RESET_EMAIL=you@example.com \
 *   ADMIN_RESET_PASSWORD='a-strong-password' \
 *   node dist/auth/reset-admin-password.js
 *
 * On a platform, set those two variables, run the command once, then REMOVE
 * them. Leaving a password in the environment is exactly the habit this script
 * exists to avoid.
 *
 * ─── DESIGN NOTES ───────────────────────────────────────────────────────────
 * • Uses the SAME bcrypt cost as the running app (AUTH_BCRYPT_ROUNDS), so the
 *   resulting hash is indistinguishable from one the app would produce.
 * • Bumps `tokenVersion`, which invalidates every existing access and refresh
 *   token for that user. If the password was lost because it leaked, leaving
 *   old sessions alive would defeat the whole point.
 * • Refuses to CREATE a user. This is a recovery tool, not a back door for
 *   minting admins — an unknown email is an error, not an invitation.
 * • Enforces a minimum length, because a recovery path that accepts "1234"
 *   quietly becomes the weakest way into the system.
 */
import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import AppDataSource from '../database/data-source';
import { UserEntity } from './entities/user.entity';
import { loadAuthConfig } from '../config/auth.config';

/** Short enough not to be annoying, long enough not to be the weak link. */
const MIN_PASSWORD_LENGTH = 12;

async function main(): Promise<void> {
  const email = (process.env.ADMIN_RESET_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_RESET_PASSWORD || '';

  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: ADMIN_RESET_EMAIL=<email> ADMIN_RESET_PASSWORD=<password> '
      + 'node dist/auth/reset-admin-password.js',
    );
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    // eslint-disable-next-line no-console
    console.error(`[reset] password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  const ds = await AppDataSource.initialize();
  try {
    const users = ds.getRepository(UserEntity);
    const user = await users.findOne({ where: { email } });

    if (!user) {
      // Deliberately does NOT create one. A recovery tool that can mint a new
      // admin from an arbitrary email is a privilege-escalation path, not a
      // recovery path.
      // eslint-disable-next-line no-console
      console.error(
        `[reset] no user with email "${email}". This tool resets an EXISTING `
        + 'admin; it will not create one.',
      );
      process.exit(1);
    }

    // Same cost factor as the running app, so the hash is identical in kind to
    // one produced by a normal password change.
    const rounds = loadAuthConfig().bcryptRounds;
    user.passwordHash = await bcrypt.hash(password, rounds);

    // Kill every existing session. If the password was lost because it leaked,
    // leaving old tokens valid would defeat the reset entirely.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.active = true;

    await users.save(user);

    // eslint-disable-next-line no-console
    console.log(
      `[reset] password updated for ${email} (bcrypt rounds=${rounds}). `
      + 'All existing sessions were invalidated.',
    );
    // eslint-disable-next-line no-console
    console.log('[reset] NOW REMOVE ADMIN_RESET_EMAIL and ADMIN_RESET_PASSWORD from the environment.');
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[reset] failed:', err);
  process.exit(1);
});
