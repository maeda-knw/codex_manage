import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConversationWebviewState } from '../webview/conversation/protocol';

export function conversationWebviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
}

export function configureConversationWebview(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): void {
  webview.options = {
    enableScripts: true,
    enableForms: false,
    enableCommandUris: false,
    localResourceRoots: [conversationWebviewRoot(extensionUri)]
  };
}

export function createConversationWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  state: ConversationWebviewState
): string {
  const nonce = randomBytes(18).toString('base64');
  const root = conversationWebviewRoot(extensionUri);
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'conversation.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'conversation.css'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <link rel="stylesheet" href="${escapeAttribute(styleUri.toString())}">
  <title>${escapeHtml(state.title)}</title>
</head>
<body
  data-state-version="${state.version}"
  data-thread-id="${escapeAttribute(state.threadId)}"
  data-thread-title="${escapeAttribute(state.title)}"
>
  <header class="page-header">
    <div class="page-heading">
      <h1 id="thread-title">${escapeHtml(state.title)}</h1>
      <p id="thread-meta" class="muted">Loading conversation history…</p>
    </div>
    <button id="reload-button" class="secondary-button" type="button">Reload history</button>
  </header>
  <div id="notice" class="notice" role="status" aria-live="polite">Loading conversation history…</div>
  <main id="conversation" aria-live="polite" aria-busy="true"></main>
  <script nonce="${nonce}" src="${escapeAttribute(scriptUri.toString())}"></script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\'':
        return '&#39;';
      default:
        return character;
    }
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
