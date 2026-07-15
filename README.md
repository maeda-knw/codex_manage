# Codex Thread Manager

Codex Thread Manager is a VS Code extension for organizing Codex threads associated with the current workspace.

## Current status

This repository currently contains the Phase 2 App Server connection from `PLAN.md`:

- A VS Code workspace extension that contributes a Codex activity-bar container.
- A `Threads` tree view with placeholder groups for pinned, recent, and archived threads.
- Command and configuration contributions for the MVP surface area.
- A version-pinned Codex App Server TypeScript protocol snapshot (generated with Codex CLI `0.144.2`).
- A local stdio JSONL client with initialization, request timeouts, diagnostics, and clean shutdown.
- A read-only `thread/list` connection probe scoped to the open workspace folders.

Rendering real thread rows and archived pagination starts in Phase 3. The Phase 2 probe reads thread metadata only and does not mutate Codex data.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm run build
```

To refresh the checked-in protocol snapshot with the installed Codex CLI:

```bash
npm run generate:protocol
```
Set `CODEX_PATH` when generating from a CLI outside `PATH`. At runtime, configure `codexThreadManager.codexPath` in VS Code instead.

Use the VS Code `Run Extension` launch configuration to open an Extension Development Host.
