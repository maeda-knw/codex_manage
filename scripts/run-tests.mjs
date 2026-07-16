import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const outputDirectory = await mkdtemp(join(tmpdir(), 'codex-thread-manager-tests-'));
try {
  await build({
    entryPoints: [
      'test/unit/codexExecutableResolver.test.mjs',
      'test/integration/appServerCompatibility.test.ts',
      'test/integration/realCli.test.ts'
    ],
    bundle: true,
    entryNames: '[dir]/[name]',
    format: 'cjs',
    outbase: 'test',
    platform: 'node',
    target: 'node20',
    outdir: outputDirectory,
    logLevel: 'silent'
  });
  run(process.execPath, [
    '--test',
    join(outputDirectory, 'unit', 'codexExecutableResolver.test.js'),
    join(outputDirectory, 'integration', 'appServerCompatibility.test.js'),
    join(outputDirectory, 'integration', 'realCli.test.js')
  ]);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`Test command exited with status ${result.status ?? 'unknown'}.`);
  }
}
