import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Runs before any test/source module loads — used to set env (e.g. generous
    // rate-limit ceilings) that source modules capture at import time.
    setupFiles: ['tests/setup-env.ts'],
    // NestJS DI + class-validator rely on `emitDecoratorMetadata`, which esbuild
    // (vitest's default transformer) does NOT implement. SWC does — so we
    // transform test + source through SWC to get correct decorator metadata.
    globals: true,
  },
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2022',
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
});
