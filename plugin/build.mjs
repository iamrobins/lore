import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

// Anchored to this file so the build works from anywhere.
const here = path.dirname(fileURLToPath(import.meta.url));

// dist/ is committed for this package, unlike everywhere else in the repo:
// `/plugin marketplace add` clones the repository and runs what it finds, with
// no install or build step of its own.
await esbuild.build({
  entryPoints: [path.join(here, 'src/hook.ts')],
  outfile: path.join(here, 'dist/hook.js'),
  bundle: true,
  // CommonJS, unlike the MCP server: a hook is a short-lived script run by
  // filename, and an ESM bundle with no package.json beside it makes Node print
  // a module-type warning to stderr on every single tool call. CJS also lets
  // gray-matter's runtime require() work without a shim.
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
