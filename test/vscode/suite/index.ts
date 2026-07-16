import assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'codex-thread-manager.codex-thread-manager';

export async function run(): Promise<void> {
  assert.equal(vscode.workspace.workspaceFolders, undefined);

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) {
    throw new Error(`Expected ${EXTENSION_ID} to be installed in the Extension Development Host.`);
  }
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    'codexThreadManager.refresh',
    'codexThreadManager.openSettings',
    'codexThreadManager.loadMoreActive',
    'codexThreadManager.loadMoreArchive',
    'codexThreadManager.pin',
    'codexThreadManager.unpin',
    'codexThreadManager.rename',
    'codexThreadManager.archive',
    'codexThreadManager.unarchive'
  ]) {
    assert.equal(commands.has(command), true, `Expected command ${command} to be registered.`);
  }

  const manifest = extension.packageJSON as {
    contributes?: {
      commands?: Array<{ command?: string; icon?: string; title?: string }>;
      views?: Record<string, Array<{ id?: string }>>;
      menus?: {
        'view/title'?: Array<{ command?: string; group?: string; when?: string }>;
        'view/item/context'?: Array<{ command?: string; when?: string }>;
      };
    };
    extensionKind?: string[];
  };
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.equal(
    manifest.contributes?.views?.codexThreadManager?.some(
      (view) => view.id === 'codexThreadManager.threads'
    ),
    true
  );

  assert.equal(
    manifest.contributes?.commands?.some((command) =>
      command.command === 'codexThreadManager.openSettings' &&
      command.title === 'Open Settings' &&
      command.icon === '$(gear)'
    ),
    true
  );
  const titleMenuEntries = manifest.contributes?.menus?.['view/title'] ?? [];
  assert.equal(
    titleMenuEntries.some((entry) =>
      entry.command === 'codexThreadManager.refresh' &&
      entry.group === 'navigation@1'
    ),
    true
  );
  assert.equal(
    titleMenuEntries.some((entry) =>
      entry.command === 'codexThreadManager.openSettings' &&
      entry.group === 'navigation@2' &&
      entry.when === 'view == codexThreadManager.threads'
    ),
    true
  );

  const menuEntries = manifest.contributes?.menus?.['view/item/context'] ?? [];
  assert.equal(
    menuEntries.some((entry) =>
      entry.command === 'codexThreadManager.unarchive' &&
      entry.when?.includes('codexThreadManager.thread.archived')
    ),
    true
  );
  assert.equal(
    menuEntries.some((entry) =>
      entry.command === 'codexThreadManager.archive' &&
      entry.when?.includes('codexThreadManager.thread.active')
    ),
    true
  );

  const configuration = vscode.workspace.getConfiguration('codexThreadManager');
  assert.equal(configuration.get('codexPath'), 'codex');
  assert.equal(configuration.get('pageSize'), 50);
}
