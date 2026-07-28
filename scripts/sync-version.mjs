/**
 * One version, three manifests.
 *
 * The extension, the npm package and the Claude Code plugin each carry a
 * version, and the plugin's is load-bearing: installs are cached per version, so
 * shipping a hook fix without bumping it serves users the old code from cache.
 * Rather than remember three files, the root package.json is the source of truth
 * and this copies it into the other two.
 *
 * Runs as part of `npm run compile:all`, and CI fails if it would change
 * anything that is already committed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));

const { version } = readJson('package.json');

const targets = ['mcp/package.json', 'plugin/.claude-plugin/plugin.json'];

for (const target of targets) {
  const manifest = readJson(target);
  if (manifest.version === version) continue;

  manifest.version = version;
  // Trailing newline so the file matches what npm and editors write.
  writeFileSync(path.join(repositoryRoot, target), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${target}: -> ${version}`);
}
