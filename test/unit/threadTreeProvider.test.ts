import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import type { ThreadDisplayModel, ThreadRepositorySnapshot } from '../../src/codex/threadRepository';
import { ThreadTreeItem, ThreadTreeProvider } from '../../src/views/threadTreeProvider';

function displayThread(overrides: Partial<ThreadDisplayModel> = {}): ThreadDisplayModel {
  const date = new Date('2026-07-16T00:00:00Z');
  return {
    id: 'thread-a',
    title: 'Thread A',
    description: 'now • Idle',
    tooltip: new vscode.MarkdownString('tooltip'),
    cwd: 'D:\\workspace',
    createdAt: date,
    updatedAt: date,
    recencyAt: date,
    statusLabel: 'Idle',
    iconId: 'comment-discussion',
    archived: false,
    pinned: false,
    sourceLabel: 'vscode',
    ...overrides
  };
}

function children(provider: ThreadTreeProvider, element?: never): vscode.TreeItem[] {
  return provider.getChildren(element) as vscode.TreeItem[];
}

function setWorkspaceFolders(workspaceFolders: Array<{ uri: { fsPath: string } }>): void {
  (vscode.workspace as unknown as {
    workspaceFolders: Array<{ uri: { fsPath: string } }>;
  }).workspaceFolders = workspaceFolders;
}

test('shows a workspace guidance message when no folder is open', () => {
  setWorkspaceFolders([]);
  const provider = new ThreadTreeProvider();

  const items = children(provider);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.label, 'Open a workspace folder');
  provider.dispose();
});

test('renders pinned, recent, archive, and load-more rows with correct contexts', () => {
  setWorkspaceFolders([{ uri: { fsPath: 'D:\\workspace' } }]);
  const provider = new ThreadTreeProvider();
  const pinned = displayThread({ pinned: true, iconId: 'pinned' });
  const recent = displayThread({ id: 'thread-b', title: 'Thread B' });
  const archived = displayThread({ id: 'thread-c', title: 'Thread C', archived: true, iconId: 'archive' });
  const snapshot: ThreadRepositorySnapshot = {
    pinned: { threads: [pinned], nextCursor: null, loaded: true },
    active: { threads: [recent], nextCursor: 'next', loaded: true },
    archive: { threads: [archived], nextCursor: null, loaded: true }
  };
  provider.setSnapshot(snapshot);
  provider.setConnectionStatus({ kind: 'ready' });

  const roots = children(provider);
  assert.deepEqual(roots.map((item) => item.label), ['Pinned', 'Recent Threads', 'Archive']);

  const pinnedItems = children(provider, roots[0] as never);
  assert.equal(pinnedItems[0]?.contextValue, 'codexThreadManager.thread.active.pinned');

  const recentItems = children(provider, roots[1] as never);
  assert.equal(recentItems[0]?.contextValue, 'codexThreadManager.thread.active.unpinned');
  assert.equal(recentItems[1]?.contextValue, 'codexThreadManager.loadMore.active');

  const archiveItems = children(provider, roots[2] as never);
  assert.equal(archiveItems[0]?.contextValue, 'codexThreadManager.thread.archived');
  provider.dispose();
});

test('exposes accessible thread labels', () => {
  const item = new ThreadTreeItem(displayThread());
  assert.equal(item.accessibilityInformation?.label, 'Thread A, now • Idle');
});
