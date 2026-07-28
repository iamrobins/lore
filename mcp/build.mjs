import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

// Anchored to this file, not the working directory, so the build works whether
// it is run from mcp/ or from the repository root.
const here = path.dirname(fileURLToPath(import.meta.url));

// The store lives in ../src and is bundled in from there. esbuild follows the
// relative import across the package boundary, so the published package is one
// self-contained file with no dependency on the extension.
await esbuild.build({
  entryPoints: [path.join(here, 'src/server.ts')],
  outfile: path.join(here, 'dist/server.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  // gray-matter is CommonJS and calls require() at runtime. An ESM bundle has no
  // require, so esbuild's shim throws; handing it a real one from createRequire
  // is the supported way to bundle CJS dependencies into an ESM output.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
