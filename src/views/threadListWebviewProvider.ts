import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ThreadRepositorySnapshot } from '../codex/threadRepository';
import { isThreadsWebviewMessage, type ThreadsHostToWebviewMessage } from '../webview/threads/protocol';
import type { ConnectionStatus } from './threadTreeProvider';

export class ThreadListWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private snapshot: ThreadRepositorySnapshot = { pinned: { threads: [], nextCursor: null, loaded: true }, active: { threads: [], nextCursor: null, loaded: false }, archive: { threads: [], nextCursor: null, loaded: false } };
  private status: ConnectionStatus = { kind: 'idle' };
  public constructor(private readonly extensionUri: vscode.Uri) {}
  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isThreadsWebviewMessage(message)) return;
      if (message.type === 'threads/ready') {
        this.postState();
        return;
      }
      const command = `codexThreadManager.${message.command}`;
      void vscode.commands.executeCommand(command, message.threadId);
    });
  }
  public setSnapshot(snapshot: ThreadRepositorySnapshot): void { this.snapshot = snapshot; this.postState(); }
  public setConnectionStatus(status: ConnectionStatus): void { this.status = status; this.postState(); }
  public dispose(): void { this.view = undefined; }
  private postState(): void {
    const message: ThreadsHostToWebviewMessage = { type: 'threads/state', snapshot: this.snapshot, status: this.status, hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length) };
    void this.view?.webview.postMessage(message);
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'threads.js'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>Codex Threads</title><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:0 10px}header{display:flex;gap:6px;align-items:center;justify-content:space-between}h2{font-size:12px;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin:18px 0 7px}.thread-card{min-height:44px;padding:8px;margin:5px 0;border:1px solid var(--vscode-panel-border);border-radius:5px;background:var(--vscode-sideBar-background)}.thread-card:focus-within{outline:1px solid var(--vscode-focusBorder)}button{font:inherit;color:inherit;background:var(--vscode-button-secondaryBackground);border:0;border-radius:3px;padding:3px 6px;margin:2px;cursor:pointer}.thread-title{display:block;width:100%;text-align:left;background:none;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.thread-card div{font-size:11px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style></head><body><main id="threads" aria-live="polite" aria-busy="true">Loading threads…</main><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}
