import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppServerClient } from '../../src/codex/appServerClient';
import type { Thread } from '../../src/codex/protocol/generated/v2/Thread';
import type { ThreadListParams } from '../../src/codex/protocol/generated/v2/ThreadListParams';
import { ThreadRepository } from '../../src/codex/threadRepository';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

class FakeClient {
  public readonly listCalls: ThreadListParams[] = [];
  public readonly renameCalls: Array<{ threadId: string; name: string }> = [];
  public readonly archiveCalls: string[] = [];
  public readonly unarchiveCalls: string[] = [];
  public pages: Array<{ data: Thread[]; nextCursor: string | null; backwardsCursor: string | null }> = [];
  public operationFailure: Error | undefined;
  public renameGate: Deferred | undefined;

  public async listThreads(params: ThreadListParams) {
    this.listCalls.push(params);
    const page = this.pages.shift();
    if (!page) {
      throw new Error('Missing fixture page.');
    }
    return page;
  }

  public async renameThread(params: { threadId: string; name: string }): Promise<void> {
    this.renameCalls.push(params);
    if (this.renameGate) {
      await this.renameGate.promise;
    }
    if (this.operationFailure) {
      throw this.operationFailure;
    }
  }

  public async archiveThread(params: { threadId: string }): Promise<void> {
    this.archiveCalls.push(params.threadId);
    if (this.operationFailure) {
      throw this.operationFailure;
    }
  }

  public async unarchiveThread(params: { threadId: string }): Promise<void> {
    this.unarchiveCalls.push(params.threadId);
    if (this.operationFailure) {
      throw this.operationFailure;
    }
  }
}

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: `Preview ${id}\nsecond line`,
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    recencyAt: 1_700_000_100,
    status: { type: 'idle' },
    path: null,
    cwd: 'D:\\workspace',
    cliVersion: '0.144.2',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: `Thread ${id}`,
    turns: [],
    ...overrides
  };
}

function page(data: Thread[], nextCursor: string | null = null) {
  return { data, nextCursor, backwardsCursor: null };
}

function workspaceFolder(fsPath: string) {
  return { uri: { fsPath } };
}

function repository(client: FakeClient): ThreadRepository {
  return new ThreadRepository(client as unknown as AppServerClient);
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('loads workspace-scoped pages, applies title fallbacks, and preserves pin order', async () => {
  const client = new FakeClient();
  client.pages.push(
    page([
      thread('a', { name: null, preview: 'Preview title\nbody' }),
      thread('b', { name: '  ', preview: '' })
    ], 'next-active'),
    page([thread('c')])
  );
  const repo = repository(client);
  repo.setPinnedThreadIds(['b', 'a']);
  const folders = [workspaceFolder('D:\\One'), workspaceFolder('D:\\Two')];

  await repo.refreshActive(folders as never, 2);
  await repo.loadMoreActive(folders as never, 2);

  assert.deepEqual(client.listCalls, [
    {
      limit: 2,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false,
      cursor: null,
      cwd: ['D:\\One', 'D:\\Two']
    },
    {
      limit: 2,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false,
      cursor: 'next-active',
      cwd: ['D:\\One', 'D:\\Two']
    }
  ]);
  assert.deepEqual(repo.snapshot().pinned.threads.map((item) => item.title), ['Untitled thread', 'Preview title']);
  assert.deepEqual(repo.snapshot().active.threads.map((item) => item.id), ['c']);
});

test('moves threads between active and archive and keeps failed operations unchanged', async () => {
  const client = new FakeClient();
  client.pages.push(page([thread('a')]), page([]));
  const repo = repository(client);
  await repo.refreshActive([workspaceFolder('D:\\workspace')] as never, 50);
  await repo.refreshArchive([workspaceFolder('D:\\workspace')] as never, 50);

  await repo.archiveThread('a');
  assert.deepEqual(repo.snapshot().active.threads, []);
  assert.equal(repo.snapshot().archive.threads[0]?.archived, true);

  await repo.unarchiveThread('a');
  assert.equal(repo.snapshot().active.threads[0]?.archived, false);
  assert.deepEqual(repo.snapshot().archive.threads, []);

  client.operationFailure = new Error('fixture failure');
  await assert.rejects(repo.archiveThread('a'), /fixture failure/u);
  assert.equal(repo.snapshot().active.threads[0]?.id, 'a');
});

test('updates names and statuses from protocol notifications using generated field names', async () => {
  const client = new FakeClient();
  client.pages.push(page([thread('a')]));
  const repo = repository(client);
  await repo.refreshActive([workspaceFolder('D:\\workspace')] as never, 50);

  assert.equal(repo.handleThreadNotification('thread/name/updated', {
    threadId: 'a',
    threadName: 'Renamed remotely'
  }), true);
  assert.equal(repo.snapshot().active.threads[0]?.title, 'Renamed remotely');

  assert.equal(repo.handleThreadNotification('thread/status/changed', {
    threadId: 'a',
    status: { type: 'systemError' }
  }), true);
  assert.equal(repo.snapshot().active.threads[0]?.statusLabel, 'Error');
  assert.equal(repo.snapshot().active.threads[0]?.iconId, 'error');
  assert.equal(repo.handleThreadNotification('thread/status/changed', {
    threadId: 'missing',
    status: { type: 'idle' }
  }), false);
});

test('prevents concurrent mutations for the same thread and clears the pending flag', async () => {
  const client = new FakeClient();
  client.pages.push(page([thread('a')]));
  client.renameGate = deferred();
  const repo = repository(client);
  await repo.refreshActive([workspaceFolder('D:\\workspace')] as never, 50);

  const first = repo.renameThread('a', 'First');
  assert.equal(repo.isOperationPending('a'), true);
  await assert.rejects(repo.renameThread('a', 'Second'), /already running/u);
  client.renameGate.resolve();
  await first;

  assert.equal(repo.isOperationPending('a'), false);
  assert.equal(repo.snapshot().active.threads[0]?.title, 'First');
});
