import * as vscode from 'vscode';

type RootItemKind = 'pinned' | 'recent' | 'archive';

export type ConnectionStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ready'; readonly pageCount: number; readonly hasMore: boolean }
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

type ThreadTreeElement = RootTreeItem | MessageTreeItem;

export class ThreadTreeProvider implements vscode.TreeDataProvider<ThreadTreeElement> {
  private readonly didChangeTreeDataEmitter = new vscode.EventEmitter<ThreadTreeElement | undefined | void>();
  private connectionStatus: ConnectionStatus = { kind: 'idle' };

  public readonly onDidChangeTreeData = this.didChangeTreeDataEmitter.event;

  public refresh(): void {
    this.didChangeTreeDataEmitter.fire();
  }

  public setConnectionStatus(status: ConnectionStatus): void {
    this.connectionStatus = status;
    this.refresh();
  }

  public getTreeItem(element: ThreadTreeElement): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ThreadTreeElement): vscode.ProviderResult<ThreadTreeElement[]> {
    if (element instanceof MessageTreeItem) {
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
      new RootTreeItem(
        'pinned',
        'Pinned',
        'Pinning starts in Phase 4.',
        'pinned',
        vscode.TreeItemCollapsibleState.Expanded
      ),
      new RootTreeItem(
        'recent',
        'Recent Threads',
        this.getConnectionDescription(),
        'history',
        vscode.TreeItemCollapsibleState.Expanded
      ),
      new RootTreeItem(
        'archive',
        'Archive',
        'Archive loading starts in Phase 3.',
        'archive',
        vscode.TreeItemCollapsibleState.Collapsed
      )
    ];
  }

  private getGroupChildren(kind: RootItemKind): ThreadTreeElement[] {
    switch (kind) {
      case 'pinned':
        return [new MessageTreeItem('No pinned threads yet', 'Pinning starts in Phase 4.', 'info')];
      case 'recent':
        return [this.getConnectionMessage()];
      case 'archive':
        return [new MessageTreeItem('Archive not loaded yet', 'Archive loading starts in Phase 3.', 'info')];
    }
  }

  private getConnectionDescription(): string {
    switch (this.connectionStatus.kind) {
      case 'idle':
        return 'Waiting to connect.';
      case 'connecting':
        return 'Connecting to Codex App Server…';
      case 'ready':
        return this.connectionStatus.hasMore
          ? `${this.connectionStatus.pageCount}+ threads found.`
          : `${this.connectionStatus.pageCount} threads found.`;
      case 'error':
        return 'Connection failed.';
    }
  }

  private getConnectionMessage(): MessageTreeItem {
    switch (this.connectionStatus.kind) {
      case 'idle':
        return new MessageTreeItem('Waiting to connect', 'Use Refresh Threads to retry.', 'debug-disconnect');
      case 'connecting':
        return new MessageTreeItem('Connecting to Codex…', 'Initializing the local App Server.', 'sync~spin');
      case 'ready':
        return new MessageTreeItem(
          'App Server connected',
          'Read-only thread rows arrive in Phase 3.',
          'pass-filled'
        );
      case 'error':
        return new MessageTreeItem('Unable to connect to Codex', this.connectionStatus.message, 'error');
    }
  }
}
