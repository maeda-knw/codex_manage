import * as vscode from 'vscode';

type RootItemKind = 'pinned' | 'recent' | 'archive';

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

  public readonly onDidChangeTreeData = this.didChangeTreeDataEmitter.event;

  public refresh(): void {
    this.didChangeTreeDataEmitter.fire();
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
        'Thread loading starts in Phase 2.',
        'pinned',
        vscode.TreeItemCollapsibleState.Expanded
      ),
      new RootTreeItem(
        'recent',
        'Recent Threads',
        'No threads loaded yet.',
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
        return [new MessageTreeItem('No threads loaded yet', 'Thread loading starts in Phase 2.', 'info')];
      case 'archive':
        return [new MessageTreeItem('Archive not loaded yet', 'Archive loading starts in Phase 3.', 'info')];
    }
  }
}
