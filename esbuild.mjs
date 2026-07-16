import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const contexts = await Promise.all([
  esbuild.context({
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
  }),
  esbuild.context({
    entryPoints: {
      conversation: 'src/webview/conversation/main.ts'
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outdir: 'dist/webview',
    sourcemap: true,
    sourcesContent: false,
    logLevel: 'info'
  })
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension sources...');
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
