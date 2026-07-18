# Testing and release checklist

The current release target is a privately distributed VSIX. Marketplace publication and marketplace metadata are out of scope.

## Automated checks

Use the pinned Node.js/npm versions and install the locked dependency tree:

```bash
nvm use
npm run bootstrap:offline
```

`bootstrap:offline` fails quickly when the local npm cache is incomplete. Retry `npm run bootstrap` with network access in that case. Both commands skip installation when the existing `node_modules` passes `npm run doctor`, and verify required packages and executable shims after `npm ci` so that a partial extraction cannot be treated as a successful setup.

Run before creating a VSIX:

```bash
npm run doctor
npm run verify
npm run test:vscode
npm run package
```

The GitHub Actions workflow runs quality, packaging, and Extension Host checks on Windows, macOS, and Linux. The local Extension Host test uses VS Code 1.92.2, matching the minimum supported release line.

## Platform matrix

| Environment | Automated coverage | Manual check |
| --- | --- | --- |
| Windows | Unit, integration, bundle, VSIX, Extension Host | Native CLI and official npm shim |
| macOS | Unit, integration, bundle, VSIX, Extension Host | Native CLI and archive/restore |
| Linux | Unit, integration, bundle, VSIX, Extension Host under Xvfb | Native CLI and archive/restore |
| WSL | Shared code paths and workspace-extension manifest | Install/authenticate CLI inside WSL and refresh threads |
| Remote SSH | Shared code paths and workspace-extension manifest | Install/authenticate CLI on the remote host |
| Dev Container | Shared code paths and workspace-extension manifest | Install/authenticate CLI in the container |

## Manual acceptance checklist

- Open a workspace with an exact-path active thread and confirm it appears.
- Confirm a nested-directory thread is not included.
- Confirm unnamed threads use the preview first line or `Untitled thread`.
- Pin two threads and confirm newest-pin-first ordering survives a window reload.
- Rename a thread and confirm another Codex client sees the new name.
- Archive a thread and confirm it moves to Archive.
- Use Undo immediately after archive.
- Restore a thread from Archive.
- Trigger or observe a running/error status change and confirm the icon and label update.
- Confirm the native **Threads** title contains the only refresh/settings controls and the Webview does not repeat its own title or text buttons.
- Collapse Pinned or Recent threads, expand Archive, navigate into a conversation and back, then reload the window and confirm the group visibility is restored.
- Select the title, description, and blank body area of a thread card and confirm each opens the matching conversation without opening an editor tab.
- Hover and keyboard-focus active cards to reveal Pin/Unpin, Rename, and Archive icons; confirm archived cards show only Restore and touch-style input does not hide the actions.
- Select each icon and the gaps around the icon strip and confirm none opens a conversation or triggers a neighboring card action.
- Use **Back** and confirm the loaded list, scroll position, and selected-row focus are restored where possible.
- Open two different threads in sequence and confirm their histories do not mix.
- Send a multiline text prompt with Ctrl/Cmd+Enter and confirm Enter alone inserts a line break.
- Double-click Send and press the shortcut repeatedly while sending; confirm only one turn starts and the draft clears only after acceptance.
- Confirm the Codex reply grows in place while streaming without collapsing an expanded work card or moving focus unexpectedly.
- Scroll away from the bottom during a response and confirm streaming does not force the viewport back down.
- Select **Stop** during a response and confirm only the visible thread's active turn is interrupted.
- Disconnect or stop the App Server, confirm the last transcript remains visible and the composer becomes unavailable, then use **Reload** and confirm resume/read restores the authoritative history.
- Switch threads while one is responding and confirm messages, execution state, and operation results never appear in the other conversation.
- Use **Reload** and confirm the sidebar history re-synchronizes without creating a new turn.
- Run **Developer: Reload Window** with a sidebar conversation open and confirm the same thread history is restored after the list loads.
- Use Arrow Up/Down, Home/End, Tab, Shift+Tab, the collapsible group headings, and every inline action to confirm visible focus and keyboard access; arrow navigation must skip collapsed groups, and list updates must preserve the active heading or card control.
- Pin into a collapsed Pinned group, archive into a collapsed Archive group, restore into Recent, and confirm focus moves to the corresponding action, card, or destination group heading without disappearing.
- Confirm message text containing HTML-like text is displayed literally and does not create executable markup.
- Confirm partial stored history shows a summary notice rather than pretending all work items are present.
- Configure a missing CLI path and confirm Settings/Retry guidance appears.
- Confirm the Output Channel reports resolved source/path and both CLI versions.
- Close the window and confirm no App Server child process remains.
- Install the generated VSIX into a clean VS Code profile and repeat the basic list/pin/rename/archive flow.
- Confirm the installed VSIX can load both the thread list and sidebar conversation styles/scripts.

## Real CLI smoke test

The opt-in smoke test remains read-only even though the extension can send messages. It calls `initialize`, `thread/list`, and, when a matching thread exists, `thread/read(includeTurns: true)`. It asserts only the thread ID and turn-array shape and does not print conversation content:

```powershell
$env:CODEX_SMOKE_PATH = 'C:\path\to\codex.cmd'
npm test
```

Do not extend this smoke test with rename or archive operations against a user's normal Codex home.
