import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';

const extensionDevelopmentPath = resolve('.');
const testOutputDirectory = resolve('.vscode-test', 'suite');
const extensionTestsPath = join(testOutputDirectory, 'index.js');

await mkdir(testOutputDirectory, { recursive: true });
await build({
  entryPoints: ['test/vscode/suite/index.ts'],
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: extensionTestsPath,
  logLevel: 'silent'
});

await runTests({
  version: '1.92.2',
  extensionDevelopmentPath,
  extensionTestsPath,
  extensionTestsEnv: {
    ELECTRON_RUN_AS_NODE: undefined
  },
  launchArgs: [
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes'
  ]
});
