# Codex Thread Manager

Codex Thread Manager is a VS Code extension for organizing Codex threads associated with the current workspace.

## Current status

This repository currently contains the Phase 1 scaffold from `PLAN.md`:

- A VS Code workspace extension that contributes a Codex activity-bar container.
- A `Threads` tree view with placeholder groups for pinned, recent, and archived threads.
- Command and configuration contributions for the MVP surface area.
- TypeScript, ESLint, and esbuild project setup.

App Server connectivity and real thread data are planned for the next implementation phases.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm run build
```

Use the VS Code `Run Extension` launch configuration to open an Extension Development Host.
