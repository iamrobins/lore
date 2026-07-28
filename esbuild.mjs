import esbuild from 'esbuild';

const isWatchMode = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // VS Code provides this at runtime; bundling it would break the extension host.
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

if (isWatchMode) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
} else {
  await esbuild.build(buildOptions);
}
