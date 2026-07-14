import * as vscode from 'vscode';

type RootItemKind = 'pinned' | 'recent' | 'archive';

class RootTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly kind: RootItemKind,
    label: string,
    description: string,
    iconId: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = `codexThreadManager.${kind}Group`;
  }
}

export class ThreadTreeProvider implements vscode.TreeDataProvider<RootTreeItem> {
  private readonly didChangeTreeDataEmitter = new vscode.EventEmitter<RootTreeItem | undefined | void>();

  public readonly onDidChangeTreeData = this.didChangeTreeDataEmitter.event;

  public refresh(): void {
    this.didChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: RootTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: RootTreeItem): vscode.ProviderResult<RootTreeItem[]> {
    if (element) {
      return [];
    }

    if (!vscode.workspace.workspaceFolders?.length) {
      return [
        new RootTreeItem(
          'recent',
          'Open a workspace folder',
          'Codex threads are scoped to VS Code workspace folders.',
          'folder-opened'
        )
      ];
    }

    return [
      new RootTreeItem('pinned', 'Pinned', 'Thread loading starts in Phase 2.', 'pinned'),
      new RootTreeItem('recent', 'Recent Threads', 'No threads loaded yet.', 'history'),
      new RootTreeItem('archive', 'Archive', 'Archive loading starts in Phase 3.', 'archive')
    ];
  }
}
