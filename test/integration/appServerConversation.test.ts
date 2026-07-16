import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { AppServerClient } from '../../src/codex/appServerClient';
import type { CodexCommand } from '../../src/codex/codexExecutableResolver';
import { AppServerError } from '../../src/common/errors';

const fakeServerPath = resolve(process.cwd(), 'test', 'integration', 'fake-app-server.mjs');

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
    versionProbe: async () => ({ raw: 'codex-cli 0.144.2', version: '0.144.2' })
  });
}

test('reads the requested thread with stored turns and items', async (t) => {
  const logs: string[] = [];
  const client = createClient('thread-read', logs);
  t.after(() => client.dispose());

  const response = await client.readThread({
    threadId: 'thread-1',
    includeTurns: true
  });

  assert.equal(response.thread.id, 'thread-1');
  assert.equal(response.thread.turns[0]?.items[0]?.type, 'userMessage');
  assert.equal(response.thread.turns[0]?.items[1]?.type, 'agentMessage');
});

test('classifies malformed conversation history as an incompatible CLI boundary', async (t) => {
  const logs: string[] = [];
  const client = createClient('malformed-thread-read', logs);
  t.after(() => client.dispose());

  await assert.rejects(
    client.readThread({ threadId: 'thread-1', includeTurns: true }),
    (error) => error instanceof AppServerError && error.code === 'incompatible-cli'
  );
  assert.equal(client.getDiagnostics().compatibility, 'incompatible');
  assert.equal(logs.some((line) => line.includes('invalid thread/read response')), true);
});
