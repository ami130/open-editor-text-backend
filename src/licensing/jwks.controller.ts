/**
 * jwks.controller.ts — GET /.well-known/jwks.json
 *
 * Serves the PUBLIC key(s) used to sign licenses, so an editor host can build
 * its verification keyring by fetching this (standard JWKS shape). Exposes only
 * public material — never the private key. When multiple keys exist (rotation),
 * all current public keys are listed by `kid`.
 */
import { Controller, Get, ServiceUnavailableException, Inject } from '@nestjs/common';
import { LicenseSignerService } from './license-signer.service';
import { Public } from '../auth/decorators';

@Public() // public key set — must be fetchable by editors without a session
@Controller('.well-known')
export class JwksController {
  constructor(@Inject(LicenseSignerService) private readonly signer: LicenseSignerService) {}

  @Get('jwks.json')
  jwks() {
    if (!this.signer.enabled) {
      throw new ServiceUnavailableException('No signing key configured.');
    }
    // Current + retired public keys, so licenses signed before a key rotation
    // still verify against their (still-published) kid.
    return { keys: this.signer.publicJwks() };
  }
}
