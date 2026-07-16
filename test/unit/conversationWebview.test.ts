import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import {
  configureConversationWebview,
  createConversationWebviewHtml
} from '../../src/conversation/conversationWebview';

function createWebview(): vscode.Webview {
  return {
    cspSource: 'vscode-webview-resource:',
    options: {},
    html: '',
    asWebviewUri: (uri: vscode.Uri) => vscode.Uri.file(`webview${uri.fsPath}`),
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
    postMessage: async () => true
  } as unknown as vscode.Webview;
}

test('creates a nonce-protected shell with escaped persisted state', () => {
  const extensionUri = vscode.Uri.file('/extension');
  const webview = createWebview();
  const html = createConversationWebviewHtml(webview, extensionUri, {
    version: 1,
    threadId: 'thread-"quoted"',
    title: '<script>alert(1)</script>'
  });

  assert.match(html, /default-src 'none'/u);
  assert.match(html, /script-src 'nonce-[^']+'/u);
  assert.equal(html.includes('unsafe-inline'), false);
  assert.match(html, /dist\/webview\/conversation\.js/u);
  assert.match(html, /dist\/webview\/conversation\.css/u);
  assert.equal(html.includes('<title><script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /data-thread-id="thread-&quot;quoted&quot;"/u);
});

test('restricts webview capabilities and local resource roots', () => {
  const extensionUri = vscode.Uri.file('/extension');
  const webview = createWebview();

  configureConversationWebview(webview, extensionUri);

  assert.equal(webview.options.enableScripts, true);
  assert.equal(webview.options.enableForms, false);
  assert.equal(webview.options.enableCommandUris, false);
  assert.equal(
    webview.options.localResourceRoots?.[0]?.fsPath,
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview').fsPath
  );
});
