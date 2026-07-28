import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

// Anchored to this file so the build works from anywhere.
const here = path.dirname(fileURLToPath(import.meta.url));

// dist/ is committed for this package, unlike everywhere else in the repo:
// `/plugin marketplace add` clones the repository and runs what it finds, with
// no install or build step of its own.

/** The hook: a short-lived script Claude Code runs by filename on every tool call. */
await esbuild.build({
  entryPoints: [path.join(here, 'src/hook.ts')],
  outfile: path.join(here, 'dist/hook.js'),
  bundle: true,
  // CommonJS: an ESM bundle with no package.json beside it makes Node print a
  // module-type warning to stderr on every single tool call. CJS also lets
  // gray-matter's runtime require() work without a shim.
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

// The MCP server, bundled in here rather than referenced from ../mcp.
//
// Claude Code copies only the plugin directory into its cache, so a path
// reaching outside it — as `${CLAUDE_PLUGIN_ROOT}/../mcp/dist/server.js` did —
// resolves to nothing once installed. The server then fails to start with no
// error surfaced anywhere, leaving the agent with hooks and no lore_read,
// lore_search or lore_write. Same source as the npm package; two distributions.
await esbuild.build({
  entryPoints: [path.join(here, '../mcp/src/server.ts')],
  outfile: path.join(here, 'dist/server.mjs'),
  bundle: true,
  // ESM here, unlike the hook: the server uses top-level await to connect its
  // transport. The createRequire banner is what lets the bundled CommonJS
  // gray-matter call require() at runtime.
  format: 'esm',
  platform: 'node',
  target: 'node18',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
