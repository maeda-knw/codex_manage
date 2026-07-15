import { rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(repositoryRoot, 'src', 'codex', 'protocol', 'generated');
const temporaryDirectory = `${outputDirectory}.tmp-${process.pid}`;
const codexPath = process.env.CODEX_PATH ?? 'codex';

await rm(temporaryDirectory, { recursive: true, force: true });

try {
  const generation = spawnSync(codexPath, ['app-server', 'generate-ts', '--out', temporaryDirectory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true
  });

  if (generation.error) {
    throw generation.error;
  }

  if (generation.status !== 0) {
    throw new Error(`codex app-server generate-ts exited with status ${generation.status ?? 'unknown'}.`);
  }

  const versionResult = spawnSync(codexPath, ['--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  const version = versionResult.status === 0 ? versionResult.stdout.trim() : 'unknown Codex CLI version';

  await writeFile(
    join(temporaryDirectory, 'README.md'),
    [
      '# Generated Codex App Server protocol',
      '',
      `Generated with \`${version}\`.`,
      '',
      'Do not edit these files by hand. Run `npm run generate:protocol` to replace the snapshot.',
      ''
    ].join('\n'),
    'utf8'
  );

  await rm(outputDirectory, { recursive: true, force: true });
  await rename(temporaryDirectory, outputDirectory);
  console.log(`Generated Codex App Server protocol with ${version}.`);
} catch (error) {
  await rm(temporaryDirectory, { recursive: true, force: true });
  throw error;
}
