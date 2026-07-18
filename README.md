# Codex Thread Manager

Codex Thread Manager is a VS Code extension for organizing Codex threads associated with the current workspace.

The MVP is packaged for private VSIX installation. Marketplace publication is not currently planned.

## Features

- Lists active and archived Codex threads whose `cwd` exactly matches an open workspace folder.
- Keeps workspace-local pinned threads in a dedicated group.
- Renames active threads through the Codex App Server.
- Archives threads, supports immediate Undo, and restores archived threads.
- Loads large thread collections page by page.
- Updates names, archive state, and execution status from App Server notifications.
- Opens a selected thread's conversation in the same Codex sidebar, including stored user/Codex messages, turn state, and summarized work cards.
- Sends text prompts to an existing thread, streams Codex replies in place, and stops the active turn when needed.
- Adds PNG, JPEG, GIF, or WebP images, file mentions, and enabled workspace Skills to the next message from the composer Add menu.
- Starts a workspace-scoped conversation from the sidebar, applies the selected Runtime settings, and sends its first text prompt without creating a duplicate list entry.
- Shows a compact summary in the Runtime trigger with the GPT version and variant, effective reasoning, Fast speed when selected, and non-standard sandbox permissions.
- Keeps the last confirmed transcript visible across disconnects and re-synchronizes it with `thread/resume` plus `thread/read` after reconnecting.
- Preserves the list position when navigating back and restores the selected conversation by re-reading history after a VS Code window reload.
- Keeps Pinned and Recent threads expanded by default, keeps Archive collapsed, and remembers each group's visibility.
- Opens a conversation from the full thread-card body and exposes pin, rename, archive, and restore as inline icon actions.
- Reports CLI resolution, runtime/generated protocol versions, and compatibility diagnostics in the `Codex Thread Manager` Output Channel.

Pinning is stored in VS Code `workspaceState`. It is not synchronized with Codex, other workspaces, or other machines.

## Requirements

- VS Code 1.92.0 or later.
- A trusted local or remote workspace.
- Codex CLI installed in the same environment where the VS Code Extension Host runs.
- Codex authentication already configured for that CLI.

The checked-in protocol snapshot was generated with Codex CLI `0.144.2`. Exact version equality is not required: the extension checks the required App Server methods and response boundaries at runtime.

## Install from VSIX

Build the private package:

```bash
nvm use
npm run bootstrap:offline
npm run package
```

If the local npm cache is incomplete, retry with network access using `npm run bootstrap`.

Then install `codex-thread-manager-0.0.1.vsix` using either:

- VS Code: **Extensions: Install from VSIX...**
- Command line:

```bash
code --install-extension codex-thread-manager-0.0.1.vsix
```

Reload VS Code after installation.

## Usage

1. Open a workspace folder.
2. Open the Codex activity-bar view.
3. Use the gear icon beside the refresh icon in the native **Threads** view title to open the extension settings.
4. Use the refresh icon if the list has not loaded.
5. Select **New conversation**, choose Runtime settings if needed, then enter the first text message and select **Send**.
6. Select anywhere in an existing thread card except its action icons to open stored conversation history in the same Codex sidebar.
7. Select a group heading to expand or collapse Pinned, Recent threads, or Archive.
8. Hover a row or focus it with the keyboard, then use its inline icons to pin, rename, archive, or restore it.
9. If the selected model supports images, use **Add** > **Add image…** to attach up to 10 PNG, JPEG, GIF, or WebP files of at most 20 MB each.
10. Use **Add** > **Mention files…** or **Add Skill…** to add file references or enabled Skills to the next message.
11. Enter a text message and select **Send**, or press Ctrl+Enter / Cmd+Enter. Enter by itself inserts a new line.
12. While Codex is responding, select **Stop** to interrupt that turn.
13. Use **Reload** to reconnect and re-synchronize the selected conversation, then **Back** to return to the list.
14. Open **View: Toggle Output** and select `Codex Thread Manager` for connection diagnostics.

Only threads whose `cwd` exactly matches one of the open workspace folder paths are shown. Threads started in a nested subdirectory are not included in this MVP.

## Configuration

### `codexThreadManager.codexPath`

Default: `codex`

With the default value, the extension resolves Codex in this order:

1. A native `codex` executable in the Extension Host `PATH`.
2. An official `@openai/codex` npm shim in `PATH`.

On Windows, npm `.cmd` and `.ps1` shims are not launched through a shell. The extension validates the adjacent `@openai/codex` package and starts its JavaScript entry point with Node.js.

Set an explicit native executable or official npm shim path when automatic resolution fails. Paths inside another VS Code extension are intentionally not searched.

### `codexThreadManager.pageSize`

Default: `50`; allowed range: `1` to `200`.

Controls how many active or archived thread records are requested per page.

## Remote, WSL, and containers

This is a workspace extension. In Remote SSH, WSL, or Dev Containers, install and authenticate Codex CLI in the remote environment rather than only on the local machine.

VS Code for the Web and Virtual Workspaces are not supported because the extension must start a local App Server child process.

## Troubleshooting

### Codex CLI was not found

- Run `codex --version` in a terminal for the same local/remote environment.
- Set `codexThreadManager.codexPath` to the native executable or official npm shim.
- Check the Output Channel to see which path the Extension Host actually resolved.

### The CLI is reported as incompatible

The runtime CLI may differ from the generated protocol version, but the required `initialize`, `thread/list`, and conversation `thread/read` boundaries must be compatible. Update Codex CLI or select another CLI path, then retry the failed operation.

### No threads are shown

- Confirm a workspace folder is open.
- Confirm the thread was created with a `cwd` exactly equal to that folder.
- Check that the thread is an interactive Codex thread rather than an exec or sub-agent history.
- Review the Output Channel for connection or boundary-validation errors.

### Remote workspace cannot connect

Install Codex CLI and complete authentication inside the remote/WSL/container environment. The local machine's CLI is not used by a remote Extension Host.

### Archive or rename failed

The local list remains unchanged when the App Server rejects an operation. Review the Output Channel, retry the action, and refresh after resolving the CLI or connection issue.

## Limitations

- Text, local-image, file mention, and enabled Skill inputs are supported for existing and newly created threads. Remote image URLs and arbitrary paths entered by the Webview are not supported.
- Command, file-change, and permission approvals plus Codex follow-up questions are supported. Unsupported App Server request types are still rejected rather than approved implicitly.
- Standard MCP form elicitations support strings, numbers, booleans, and single-select enums; OpenAI-specific forms, multi-select enums, and URL-mode elicitations can only be declined or cancelled.
- Raw reasoning content, command output, file diffs, and tool arguments/results are intentionally not displayed.
- Some older turns may contain only summary history, which is indicated in the conversation view.
- Very large stored histories are currently loaded and rendered as one snapshot; progressive rendering is planned for a later vNext phase.
- New conversations require a first text message; creating an empty thread and choosing among multiple workspace roots are not available yet.
- No thread deletion or bulk operations.
- No pin synchronization outside the current VS Code workspace.
- No nested-workspace `cwd` matching.
- No VS Code for the Web or Virtual Workspace support.
- No direct access to files under `~/.codex`; all Codex changes use the App Server.

## Development and verification

```bash
nvm use
npm run bootstrap:offline
npm run doctor
npm run verify
npm run test:vscode
npm run package
```

- `npm test`: unit and fake App Server integration tests.
- `npm run bootstrap:offline`: reuses healthy dependencies or installs from the local npm cache and fails quickly if the cache is incomplete.
- `npm run bootstrap`: reuses healthy dependencies or runs a cache-preferred locked install with bounded fetch retries and a post-install health check.
- `npm run doctor`: verifies direct dependency versions and runtime files required by TypeScript, esbuild, and VSCE.
- `npm run verify:protocol`: regenerates the App Server TypeScript protocol into a temporary directory and rejects drift from the checked-in snapshot or pinned Codex CLI version.
- `npm run test:vscode`: downloads VS Code 1.92.2 into `.vscode-test` and runs Extension Host registration tests.
- `npm run verify`: dependency health, protocol drift, unit/integration/load/security tests, Extension Host/Webview type checking, lint, bundle generation, and required VSIX-file verification.
- `npm run package`: builds the extension, verifies its runtime assets, and creates the private VSIX.

The opt-in real CLI smoke test initializes, lists one metadata record, and—when a matching thread exists—reads that thread only to validate its ID and stored-turn array:

```powershell
$env:CODEX_SMOKE_PATH = 'C:\path\to\codex.cmd'
npm test
```

See [docs/TESTING.md](docs/TESTING.md) for the platform and manual verification matrix.

To refresh the protocol snapshot, update the exact `@openai/codex` development dependency and run:

```bash
npm run generate:protocol
```

Commit the dependency, generated snapshot, and compatibility-test changes together.
