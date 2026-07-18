import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runDoctor } from '../../scripts/doctor.mjs';

const executableSuffix = process.platform === 'win32' ? '.cmd' : '';
const requiredFiles = [
  `node_modules/.bin/tsc${executableSuffix}`,
  `node_modules/.bin/esbuild${executableSuffix}`,
  `node_modules/.bin/vsce${executableSuffix}`,
  'node_modules/typescript/bin/tsc',
  'node_modules/esbuild/bin/esbuild',
  'node_modules/@vscode/vsce/vsce',
  'node_modules/@azure/identity/dist/commonjs/index.js'
];

test('detects a partial dependency extraction even when package metadata exists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dependency-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFixture(root);

  assert.equal((await runDoctor({ root, silent: true })).ok, true);
  await unlink(join(root, 'node_modules/typescript/bin/tsc'));
  const broken = await runDoctor({ root, silent: true });
  assert.equal(broken.ok, false);
  assert.equal(
    broken.problems.some((problem) => problem.includes('node_modules/typescript/bin/tsc')),
    true
  );
});

async function writeFixture(root) {
  await writeFile(join(root, '.nvmrc'), `${process.versions.node}\n`);
  await writeFile(join(root, 'package.json'), JSON.stringify({
    packageManager: 'npm@12.0.1',
    devDependencies: { typescript: '^5.5.4' }
  }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({
    packages: { 'node_modules/typescript': { version: '5.5.4' } }
  }));
  await writeFixtureFile(root, 'node_modules/typescript/package.json', JSON.stringify({ version: '5.5.4' }));
  for (const relativePath of requiredFiles) await writeFixtureFile(root, relativePath, 'fixture');
}

async function writeFixtureFile(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
