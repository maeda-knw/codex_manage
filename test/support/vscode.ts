import { join } from 'node:path';

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
  public command?: { command: string; title: string; arguments?: unknown[] };
  public accessibilityInformation?: { label: string };

  public constructor(
    public readonly label: string,
    public readonly collapsibleState = TreeItemCollapsibleState.None
  ) {}
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1
}

export class Uri {
  private constructor(
    public readonly fsPath: string,
    private readonly serialized = `file://${fsPath.replace(/\\/gu, '/')}`
  ) {}

  public static file(path: string): Uri {
    return new Uri(path);
  }

  public static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    return Uri.file(join(base.fsPath, ...pathSegments));
  }

  public toString(): string {
    return this.serialized;
  }
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

export const window: {
  createWebviewPanel: (...args: unknown[]) => unknown;
  showWarningMessage: (...args: unknown[]) => Promise<string | undefined>;
} = {
  createWebviewPanel: () => {
    throw new Error('createWebviewPanel test double was not configured.');
  },
  showWarningMessage: async () => undefined
};

export const commands: {
  executeCommand: (...args: unknown[]) => Promise<unknown>;
} = {
  executeCommand: async () => undefined
};
