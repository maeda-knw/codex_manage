import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requiredFiles = [
  'dist/extension.js',
  'dist/webview/conversation.js',
  'dist/webview/conversation.css',
  'dist/webview/threads.js',
  'dist/webview/threads.css'
];
const require = createRequire(import.meta.url);
const vsceCli = require.resolve('@vscode/vsce/vsce');
const result = spawnSync(
  process.execPath,
  [vsceCli, 'ls', '--no-dependencies'],
  { encoding: 'utf8', windowsHide: true }
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? '');
  throw new Error(`vsce ls exited with status ${result.status ?? 'unknown'}.`);
}

const packagedFiles = new Set(
  (result.stdout ?? '')
    .split(/\r?\n/u)
    .map((file) => file.trim().replace(/\\/gu, '/'))
    .filter(Boolean)
);
const missingFiles = requiredFiles.filter((file) => !packagedFiles.has(file));

if (missingFiles.length > 0) {
  throw new Error(`Required VSIX files are missing:\n${missingFiles.join('\n')}`);
}

console.log(`Verified ${requiredFiles.length} required VSIX runtime assets.`);
