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
npm ci
npm run package
```

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
3. Use **Refresh Threads** if the list has not loaded.
4. Use the row actions to pin, rename, archive, or restore a thread.
5. Open **View: Toggle Output** and select `Codex Thread Manager` for connection diagnostics.

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

The runtime CLI may differ from the generated protocol version, but the required `initialize` and `thread/list` boundaries must be compatible. Update Codex CLI or select another CLI path, then run **Refresh Threads**.

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

- No new thread creation or conversation UI.
- No thread deletion or bulk operations.
- No display of turns, messages, diffs, or tool execution history.
- No pin synchronization outside the current VS Code workspace.
- No nested-workspace `cwd` matching.
- No VS Code for the Web or Virtual Workspace support.
- No direct access to files under `~/.codex`; all Codex changes use the App Server.

## Development and verification

```bash
npm ci
npm run verify
npm run test:vscode
npm run package
```

- `npm test`: unit and fake App Server integration tests.
- `npm run test:vscode`: downloads VS Code 1.92.2 into `.vscode-test` and runs Extension Host registration tests.
- `npm run verify`: tests, type checking, lint, and bundle generation.
- `npm run package`: builds the extension and creates the private VSIX.

The opt-in real CLI smoke test only initializes and lists metadata:

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
