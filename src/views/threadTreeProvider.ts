import * as vscode from 'vscode';
import type { ThreadDisplayModel, ThreadRepositorySnapshot } from '../codex/threadRepository';

type RootItemKind = 'pinned' | 'recent' | 'archive';

export type ConnectionStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly message: string };

class RootTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly kind: RootItemKind,
    label: string,
    description: string,
    iconId: string,
    collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = `codexThreadManager.${kind}Group`;
  }
}

class MessageTreeItem extends vscode.TreeItem {
  public constructor(label: string, description: string, iconId: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = 'codexThreadManager.message';
  }
}

export class ThreadTreeItem extends vscode.TreeItem {
  public constructor(public readonly thread: ThreadDisplayModel) {
    super(thread.title, vscode.TreeItemCollapsibleState.None);
    this.id = thread.id;
    this.description = thread.description;
    this.tooltip = thread.tooltip;
    this.iconPath = new vscode.ThemeIcon(thread.iconId);
    this.contextValue = thread.archived
      ? 'codexThreadManager.thread.archived'
      : thread.pinned
        ? 'codexThreadManager.thread.active.pinned'
        : 'codexThreadManager.thread.active.unpinned';
    this.command = {
      command: 'codexThreadManager.openThread',
      title: 'Open thread conversation',
      arguments: [thread.id]
    };
    this.accessibilityInformation = { label: `${thread.title}, ${thread.description}` };
  }
}

class LoadMoreTreeItem extends vscode.TreeItem {
  public constructor(public readonly group: 'active' | 'archive') {
    super('Load more…', vscode.TreeItemCollapsibleState.None);
    this.description = 'Fetch the next page';
    this.iconPath = new vscode.ThemeIcon('more');
    this.contextValue = `codexThreadManager.loadMore.${group}`;
    this.command = {
      command: group === 'active' ? 'codexThreadManager.loadMoreActive' : 'codexThreadManager.loadMoreArchive',
      title: 'Load more threads'
    };
  }
}

type ThreadTreeElement = RootTreeItem | MessageTreeItem | ThreadTreeItem | LoadMoreTreeItem;

const EMPTY_SNAPSHOT: ThreadRepositorySnapshot = {
  pinned: { threads: [], nextCursor: null, loaded: true },
  active: { threads: [], nextCursor: null, loaded: false },
  archive: { threads: [], nextCursor: null, loaded: false }
};

export class ThreadTreeProvider implements vscode.TreeDataProvider<ThreadTreeElement>, vscode.Disposable {
  private readonly didChangeTreeDataEmitter = new vscode.EventEmitter<ThreadTreeElement | undefined | void>();
  private connectionStatus: ConnectionStatus = { kind: 'idle' };
  private snapshot: ThreadRepositorySnapshot = EMPTY_SNAPSHOT;

  public readonly onDidChangeTreeData = this.didChangeTreeDataEmitter.event;

  public refresh(): void {
    this.didChangeTreeDataEmitter.fire();
  }

  public dispose(): void {
    this.didChangeTreeDataEmitter.dispose();
  }

  public setConnectionStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    this.refresh();
  }

  public setSnapshot(snapshot: ThreadRepositorySnapshot): void {
    this.snapshot = snapshot;
    this.refresh();
  }

  public getTreeItem(element: ThreadTreeElement): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ThreadTreeElement): vscode.ProviderResult<ThreadTreeElement[]> {
    if (element instanceof MessageTreeItem || element instanceof ThreadTreeItem || element instanceof LoadMoreTreeItem) {
      return [];
    }

    if (element) {
      return this.getGroupChildren(element.kind);
    }

    if (!vscode.workspace.workspaceFolders?.length) {
      return [
        new MessageTreeItem(
          'Open a workspace folder',
          'Codex threads are scoped to VS Code workspace folders.',
          'folder-opened'
        )
      ];
    }

    return [
      new RootTreeItem('pinned', 'Pinned', this.getPinnedDescription(), 'pinned', vscode.TreeItemCollapsibleState.Expanded),
      new RootTreeItem('recent', 'Recent Threads', this.getRecentDescription(), 'history', vscode.TreeItemCollapsibleState.Expanded),
      new RootTreeItem('archive', 'Archive', this.getArchiveDescription(), 'archive', vscode.TreeItemCollapsibleState.Collapsed)
    ];
  }

  private getGroupChildren(kind: RootItemKind): ThreadTreeElement[] {
    switch (kind) {
      case 'pinned':
        return this.getThreadChildren(this.snapshot.pinned.threads, null, 'active');
      case 'recent':
        return this.getThreadChildren(this.snapshot.active.threads, this.snapshot.active.nextCursor, 'active');
      case 'archive':
        if (!this.snapshot.archive.loaded) {
          return [new MessageTreeItem('Archive not loaded yet', 'Run Refresh Threads to fetch archived threads.', 'info')];
        }
        return this.getThreadChildren(this.snapshot.archive.threads, this.snapshot.archive.nextCursor, 'archive');
    }
  }

  private getThreadChildren(
    threads: readonly ThreadDisplayModel[],
    nextCursor: string | null,
    group: 'active' | 'archive'
  ): ThreadTreeElement[] {
    const children: ThreadTreeElement[] = threads.map((thread) => new ThreadTreeItem(thread));
    if (nextCursor) {
      children.push(new LoadMoreTreeItem(group));
    }
    if (children.length > 0) {
      return children;
    }
    return [this.getConnectionMessage(group)];
  }

  private getPinnedDescription(): string {
    const count = this.snapshot.pinned.threads.length;
    return count === 1 ? '1 pinned thread.' : `${count} pinned threads.`;
  }

  private getRecentDescription(): string {
    switch (this.connectionStatus.kind) {
      case 'idle':
        return 'Waiting to connect.';
      case 'connecting':
        return 'Connecting to Codex App Server…';
      case 'ready':
        return this.snapshot.active.nextCursor
          ? `${this.snapshot.active.threads.length}+ threads found.`
          : `${this.snapshot.active.threads.length} threads found.`;
      case 'error':
        return 'Connection failed.';
    }
  }

  private getArchiveDescription(): string {
    if (!this.snapshot.archive.loaded) {
      return 'Not loaded.';
    }
    return this.snapshot.archive.nextCursor
      ? `${this.snapshot.archive.threads.length}+ archived threads.`
      : `${this.snapshot.archive.threads.length} archived threads.`;
  }

  private getConnectionMessage(group: 'active' | 'archive'): MessageTreeItem {
    if (group === 'archive' && this.connectionStatus.kind === 'ready') {
      return new MessageTreeItem('No archived threads', 'Archived workspace threads will appear here.', 'archive');
    }
    switch (this.connectionStatus.kind) {
      case 'idle':
        return new MessageTreeItem('Waiting to connect', 'Use Refresh Threads to retry.', 'debug-disconnect');
      case 'connecting':
        return new MessageTreeItem('Connecting to Codex…', 'Initializing the local App Server.', 'sync~spin');
      case 'ready':
        if (group === 'active') {
          return new MessageTreeItem('No threads in this group', 'Pin or start a Codex thread in this workspace to see it here.', 'comment-discussion');
        }
        return new MessageTreeItem('No workspace threads', 'Start a Codex thread in this workspace to see it here.', 'comment-discussion');
      case 'error':
        return new MessageTreeItem('Unable to connect to Codex', this.connectionStatus.message, 'error');
    }
  }
}
