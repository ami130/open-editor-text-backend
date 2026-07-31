/**
 * generate-key.ts — CLI: print a fresh ES256 keypair for license signing.
 *
 *   npm run key:generate
 *
 * Copy `LICENSE_PRIVATE_KEY` into your .env (server secret) and publish the
 * PUBLIC JWK/PEM to editors (the running server also serves it at
 * /.well-known/jwks.json). Never commit the private key.
 */
import { generateKeyPair } from './license-signer.service';

function main(): void {
  const kp = generateKeyPair();
  const oneLine = kp.privateKeyPem.replace(/\n/g, '\\n');
  /* eslint-disable no-console */
  console.log('\n=== ES256 license keypair ===\n');
  console.log('# .env (PRIVATE — keep secret, never commit):');
  console.log(`LICENSE_PRIVATE_KEY="${oneLine}"`);
  console.log('\n# Public key (safe to share; also served at /.well-known/jwks.json):');
  console.log(kp.publicKeyPem);
  console.log('# Public JWK:');
  console.log(JSON.stringify(kp.publicJwk));
  console.log('');
  /* eslint-enable no-console */
}

main();
