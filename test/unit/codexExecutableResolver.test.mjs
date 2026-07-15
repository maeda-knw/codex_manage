import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  CodexExecutableResolverError,
  probeCodexVersion,
  resolveCodexCommand
} from '../../src/codex/codexExecutableResolver.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-resolver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createFile(path, contents = '') {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents, { mode: 0o755 });
}

async function createWindowsNpmInstall(root) {
  const shim = join(root, 'codex.cmd');
  const node = join(root, 'node.exe');
  const packageRoot = join(root, 'node_modules', '@openai', 'codex');
  const bin = join(packageRoot, 'bin', 'codex.js');
  await createFile(shim, '@echo off');
  await createFile(node);
  await createFile(bin, 'console.log("fixture");');
  await createFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '1.2.3', bin: { codex: 'bin/codex.js' } })
  );
  return { bin, node, shim };
}

test('resolves an explicitly configured native executable path', async (t) => {
  const root = await fixture(t);
  const executable = join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await createFile(executable);

  const command = await resolveCodexCommand({ configuredPath: executable });

  assert.equal(command.executable, await realpath(executable));
  assert.deepEqual(command.prefixArgs, []);
  assert.equal(command.source, 'configured-native');
});

test('parses codex --version without a shell', async (t) => {
  const root = await fixture(t);
  const script = join(root, 'version.mjs');
  await createFile(script, 'console.log("codex-cli 9.8.7");');

  const result = await probeCodexVersion({
    executable: process.execPath,
    prefixArgs: [script],
    resolvedPath: script,
    source: 'npm-shim'
  });

  assert.deepEqual(result, { raw: 'codex-cli 9.8.7', version: '9.8.7' });
});

test('prefers a Windows PATH native executable over an earlier npm shim', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const root = await fixture(t);
  const shimDirectory = join(root, 'shim');
  const nativeDirectory = join(root, 'native');
  await createWindowsNpmInstall(shimDirectory);
  const native = join(nativeDirectory, 'codex.exe');
  await createFile(native);

  const command = await resolveCodexCommand({
    env: { Path: `${shimDirectory};${nativeDirectory}` },
    platform: 'win32'
  });

  assert.equal(command.executable, await realpath(native));
  assert.equal(command.source, 'path-native');
});

test('converts an official Windows npm shim into node plus its manifest bin entry', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const root = await fixture(t);
  const npm = await createWindowsNpmInstall(root);

  const command = await resolveCodexCommand({
    env: { Path: root },
    platform: 'win32',
    processExecutable: join(root, 'Code.exe')
  });

  assert.equal(command.executable, await realpath(npm.node));
  assert.deepEqual(command.prefixArgs, [await realpath(npm.bin)]);
  assert.equal(command.resolvedPath, await realpath(npm.shim));
  assert.equal(command.source, 'npm-shim');
});

test('rejects an untrusted configured Windows script instead of executing it through a shell', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const root = await fixture(t);
  const script = join(root, 'codex.cmd');
  await createFile(script, '@echo off');

  await assert.rejects(
    resolveCodexCommand({ configuredPath: script, env: { Path: root }, platform: 'win32' }),
    (error) => error instanceof CodexExecutableResolverError && error.code === 'invalid-npm-shim'
  );
});

test('reports a useful error when Codex is absent', async () => {
  await assert.rejects(
    resolveCodexCommand({ env: {}, platform: process.platform }),
    (error) => error instanceof CodexExecutableResolverError &&
      error.code === 'not-found' &&
      /codexThreadManager\.codexPath/u.test(error.message)
  );
});

test('never mistakes the VS Code host executable for Node.js', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const root = await fixture(t);
  const npm = await createWindowsNpmInstall(root);
  await rm(npm.node);

  await assert.rejects(
    resolveCodexCommand({
      env: { Path: root },
      platform: 'win32',
      processExecutable: join(root, 'Code.exe')
    }),
    (error) => error instanceof CodexExecutableResolverError &&
      error.code === 'not-found' &&
      /Node\.js/u.test(error.message)
  );
  assert.equal(basename(process.execPath).toLowerCase().startsWith('node'), true);
});
