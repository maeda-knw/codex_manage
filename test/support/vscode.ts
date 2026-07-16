export class MarkdownString {
  public value: string;
  public isTrusted: boolean | undefined;

  public constructor(value = '', public readonly supportThemeIcons = false) {
    this.value = value;
  }

  public appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export class ThemeIcon {
  public constructor(public readonly id: string) {}
}

export class TreeItem {
  public id?: string;
  public description?: string | boolean;
  public tooltip?: string | MarkdownString;
  public iconPath?: ThemeIcon;
  public contextValue?: string;
  public command?: { command: string; title: string };
  public accessibilityInformation?: { label: string };

  public constructor(
    public readonly label: string,
    public readonly collapsibleState = TreeItemCollapsibleState.None
  ) {}
}

type Listener<T> = (event: T) => unknown;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  public readonly event = (listener: Listener<T>): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  public fire(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

export const workspace: {
  workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
} = {
  workspaceFolders: []
};
