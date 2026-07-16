# Codex Thread Manager

Codex Thread Manager is a VS Code extension for organizing Codex threads associated with the current workspace.

## Current status

This repository currently contains the Phase 5 rename and archive work from `PLAN.md`:

- A VS Code workspace extension that contributes a Codex activity-bar container.
- A `Threads` tree view that renders workspace-scoped recent and archived Codex thread rows with status icons, relative recency, and tooltips.
- Command and configuration contributions for the MVP surface area.
- A version-pinned Codex App Server TypeScript protocol snapshot (generated with Codex CLI `0.144.2`).
- A local stdio JSONL client with initialization, request timeouts, diagnostics, and clean shutdown.
- Read-only active and archived `thread/list` loading scoped to the open workspace folders, including page cursors and manual “Load more…” rows.
- Workspace-scoped pin and unpin commands backed by VS Code `workspaceState`, with pinned threads promoted into their own group.
- Rename, archive, restore, and archive Undo commands that persist changes through the Codex App Server.
- Per-thread operation guards and notification-driven list updates for name/archive/status changes.
- Automatic native CLI and official npm shim resolution without invoking a shell.
- Runtime/generated CLI version diagnostics that validate required protocol behavior instead of requiring an exact version match.

Phase 5 can mutate Codex thread metadata through the App Server. Pinning remains local VS Code workspace state only.

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

To refresh the checked-in protocol snapshot with the exact development CLI version pinned in `package-lock.json`:

```bash
npm run generate:protocol
```

Update the exact `@openai/codex` development dependency and regenerate the protocol in the same change whenever the snapshot is upgraded.

## Codex CLI resolution and compatibility

With the default `codexThreadManager.codexPath` value, the extension resolves Codex in this order:

1. A native `codex` executable in the Extension Host `PATH`.
2. An official `@openai/codex` npm shim in `PATH`.

On Windows, npm `.cmd` and `.ps1` shims are not launched through a shell. The extension validates the adjacent `@openai/codex` manifest, resolves its `bin` entry, and starts it as `node <codex.js> ...`. If automatic resolution fails, set `codexThreadManager.codexPath` to a native executable or official npm shim. Paths inside another VS Code extension are not searched or fixed in configuration.

The Output Channel records the resolved source/path, runtime CLI version, generated protocol version, and compatibility result. A version mismatch is a warning only: successful `initialize`, `thread/list`, and response-boundary validation determine compatibility. If a required method or response boundary is incompatible, the notification includes both versions and offers settings/retry actions without exposing the resolved filesystem path.

The protocol snapshot is generated with `0.144.2`. The Phase 2.1 read-only smoke test also verifies that the official npm CLI `0.142.3` can initialize and run `thread/list` against this boundary snapshot. Run the opt-in test for another installed CLI with:

```powershell
$env:CODEX_SMOKE_PATH = 'C:\path\to\codex.cmd'
npm test
```

Use the VS Code `Run Extension` launch configuration to open an Extension Development Host.
