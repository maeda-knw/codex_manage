import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { AppServerClient, type AppServerNotification } from '../../src/codex/appServerClient';
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

function createClient(mode: string, logs: string[], requestTimeoutMs = 2_000): AppServerClient {
  return new AppServerClient({
    codexPath: 'codex',
    clientVersion: '0.0.1-test',
    logger: { appendLine: (value) => logs.push(value) },
    requestTimeoutMs,
    commandResolver: async () => fakeCommand(mode),
    versionProbe: async () => ({ raw: 'codex-cli 0.144.2', version: '0.144.2' })
  });
}

function waitForNotification(
  client: AppServerClient,
  predicate: (notification: AppServerNotification) => boolean
): Promise<AppServerNotification> {
  return new Promise((resolveNotification) => {
    const subscription = client.onNotification((notification) => {
      if (predicate(notification)) {
        subscription.dispose();
        resolveNotification(notification);
      }
    });
  });
}

test('runs rename, archive, and unarchive requests and forwards their notifications', async (t) => {
  const logs: string[] = [];
  const client = createClient('operations', logs);
  t.after(() => client.dispose());
  await client.listThreads(listParams);

  const renamed = waitForNotification(client, (notification) => notification.method === 'thread/name/updated');
  await client.renameThread({ threadId: 'thread-1', name: 'Renamed' });
  assert.deepEqual((await renamed).params, { threadId: 'thread-1', threadName: 'Renamed' });

  const archived = waitForNotification(client, (notification) => notification.method === 'thread/archived');
  await client.archiveThread({ threadId: 'thread-1' });
  assert.deepEqual((await archived).params, { threadId: 'thread-1' });

  const unarchived = waitForNotification(client, (notification) => notification.method === 'thread/unarchived');
  await client.unarchiveThread({ threadId: 'thread-1' });
  assert.deepEqual((await unarchived).params, { threadId: 'thread-1' });
});

test('times out an unanswered request and remains disposable', async (t) => {
  const logs: string[] = [];
  const client = createClient('timeout', logs, 50);
  t.after(() => client.dispose());

  await assert.rejects(
    client.listThreads(listParams),
    (error) => error instanceof AppServerError && error.code === 'request-timeout'
  );
});

test('redacts stderr secrets and ignores malformed JSONL without losing the valid response', async (t) => {
  const logs: string[] = [];
  const client = createClient('diagnostics', logs);
  t.after(() => client.dispose());

  await client.listThreads(listParams);
  await new Promise((resolveDelay) => setImmediate(resolveDelay));

  assert.equal(logs.some((line) => line.includes('Ignored malformed JSONL output')), true);
  assert.equal(logs.some((line) => line.includes('super-secret-token')), false);
  assert.equal(logs.some((line) => line.includes('fixtureSecret')), false);
  assert.equal(logs.some((line) => line.includes('[REDACTED]')), true);
});

test('reports a disconnect after a ready App Server exits', async (t) => {
  const logs: string[] = [];
  const client = createClient('disconnect', logs);
  t.after(() => client.dispose());
  const disconnected = new Promise<AppServerError>((resolveError) => {
    client.onDidDisconnect(resolveError);
  });

  await client.listThreads(listParams);
  const error = await disconnected;

  assert.equal(error.code, 'connection-closed');
  assert.match(error.message, /(?:output closed|exit code 7)/u);
});

test('rejects unsupported server requests with the original request ID', async (t) => {
  const logs: string[] = [];
  const client = createClient('server-request', logs);
  t.after(() => client.dispose());
  const rejected = waitForNotification(
    client,
    (notification) => notification.method === 'fixture/serverRequestRejected'
  );

  await client.listThreads(listParams);
  assert.deepEqual((await rejected).params, { code: -32601 });
  assert.equal(logs.some((line) => line.includes('Rejected unsupported server request fixture/approval')), true);
});
