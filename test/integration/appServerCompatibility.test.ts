import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { AppServerClient } from '../../src/codex/appServerClient';
import type { CodexCommand } from '../../src/codex/codexExecutableResolver';
import { AppServerError } from '../../src/common/errors';

const fakeServerPath = resolve(process.cwd(), 'test', 'integration', 'fake-app-server.mjs');
const listParams = {
  limit: 50,
  sortKey: 'recency_at' as const,
  sortDirection: 'desc' as const,
  archived: false,
  cwd: [process.cwd()]
};

function fakeCommand(mode: string): CodexCommand {
  return {
    executable: process.execPath,
    prefixArgs: [fakeServerPath, mode],
    resolvedPath: '<fake-codex>',
    source: 'configured-native'
  };
}

function createClient(mode: string, logs: string[]): AppServerClient {
  return new AppServerClient({
    codexPath: 'codex',
    clientVersion: '0.0.1-test',
    logger: { appendLine: (value) => logs.push(value) },
    requestTimeoutMs: 2_000,
    commandResolver: async () => fakeCommand(mode),
    versionProbe: async () => ({ raw: 'codex-cli 0.142.3', version: '0.142.3' })
  });
}

test('accepts a mismatched CLI version when required protocol boundaries are compatible', async (t) => {
  const logs: string[] = [];
  const client = createClient('compatible', logs);
  t.after(() => client.dispose());

  const page = await client.listThreads(listParams);

  assert.deepEqual(page.data, []);
  assert.deepEqual(client.getDiagnostics(), {
    compatibility: 'compatible',
    generatedVersion: '0.144.2',
    resolvedPath: '<fake-codex>',
    runtimeVersion: '0.142.3',
    source: 'configured-native'
  });
  assert.equal(logs.some((line) => line.includes('Version mismatch detected')), true);
  assert.equal(logs.some((line) => line.includes('response boundaries are compatible')), true);
});

test('reports versions and remediation when thread/list is unavailable', async (t) => {
  const logs: string[] = [];
  const client = createClient('missing-method', logs);
  t.after(() => client.dispose());

  await assert.rejects(
    client.listThreads(listParams),
    (error) => error instanceof AppServerError &&
      error.code === 'incompatible-cli' &&
      error.message.includes('0.142.3') &&
      error.message.includes('0.144.2')
  );
  assert.equal(client.getDiagnostics().compatibility, 'incompatible');
});

test('reports a boundary incompatibility instead of trusting malformed thread data', async (t) => {
  const logs: string[] = [];
  const client = createClient('malformed', logs);
  t.after(() => client.dispose());

  await assert.rejects(
    client.listThreads(listParams),
    (error) => error instanceof AppServerError && error.code === 'incompatible-cli'
  );
  assert.equal(client.getDiagnostics().compatibility, 'incompatible');
  assert.equal(logs.some((line) => line.includes('invalid thread/list response')), true);
});
