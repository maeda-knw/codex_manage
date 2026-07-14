import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const context = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info'
});

if (watch) {
  await context.watch();
  console.log('Watching extension sources...');
} else {
  await context.rebuild();
  await context.dispose();
}
