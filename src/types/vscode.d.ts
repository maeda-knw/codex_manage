declare module 'vscode' {
  export interface Disposable {
    dispose(): void;
  }

  export class EventEmitter<T> implements Disposable {
    public event: Event<T>;
    public fire(data?: T): void;
    public dispose(): void;
  }

  export type Event<T> = (listener: (e: T) => unknown) => Disposable;
  export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>;
  export type Thenable<T> = PromiseLike<T>;

  export interface ExtensionContext {
    subscriptions: Disposable[];
  }

  export namespace window {
    export function createOutputChannel(name: string): OutputChannel;
    export function registerTreeDataProvider<T>(viewId: string, treeDataProvider: TreeDataProvider<T>): Disposable;
    export function showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  }

  export namespace commands {
    export function registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
  }

  export namespace workspace {
    export const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    export function onDidChangeWorkspaceFolders(listener: (event: WorkspaceFoldersChangeEvent) => unknown): Disposable;
  }

  export interface WorkspaceFoldersChangeEvent {
    readonly added: readonly WorkspaceFolder[];
    readonly removed: readonly WorkspaceFolder[];
  }

  export interface WorkspaceFolder {
    uri: Uri;
    name: string;
    index: number;
  }

  export interface Uri {
    fsPath: string;
  }

  export interface OutputChannel extends Disposable {
    appendLine(value: string): void;
  }

  export interface TreeDataProvider<T> {
    readonly onDidChangeTreeData?: Event<T | undefined | null | void>;
    getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
    getChildren(element?: T): ProviderResult<T[]>;
  }

  export class TreeItem {
    public label?: string;
    public description?: string | boolean;
    public iconPath?: ThemeIcon;
    public contextValue?: string;
    public collapsibleState?: TreeItemCollapsibleState;
    public constructor(label: string, collapsibleState?: TreeItemCollapsibleState);
  }

  export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2
  }

  export class ThemeIcon {
    public readonly id: string;
    public constructor(id: string);
  }
}
