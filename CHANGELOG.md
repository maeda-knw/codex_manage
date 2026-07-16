# Changelog

## Unreleased

- Added vNext Phase A read-only conversation tabs backed by `thread/read(includeTurns: true)`.
- Added thread-row selection, one-tab-per-thread reuse, panel restoration, and manual history reload.
- Added typed, CSP-protected Webview rendering for stored user/Codex messages, turn state, and summarized work cards.
- Excluded raw reasoning content, command output, file diffs, tool payloads, delegated prompts, and hook fragments from the Webview model.
- Added unit and fake App Server coverage for conversation mapping, protocol boundaries, panel races/restoration, CSP, and packaged Webview assets.
- Added a view-title settings action beside Refresh Threads for quick access to the extension configuration.
- Added vNext Phase A.5 planning for a Webview View-based thread list with larger, card-like rows.
- Completed the private-distribution MVP through Phase 6.
- Added workspace-scoped pinning, rename, archive, Undo, and restore operations.
- Added notification-driven name, archive, and status updates.
- Fixed `thread/name/updated` handling to use the generated `threadName` field.
- Fixed `thread/status/changed` handling so status labels and icons update in place.
- Expanded unit and fake App Server integration coverage for JSONL transport, boundary guards, repository paging and mutations, pin persistence, tree rendering, timeouts, disconnects, diagnostics redaction, and unsupported server requests.
- Added VS Code 1.92.2 Extension Host registration tests and a cross-platform CI verification matrix.
- Added private VSIX installation, requirements, limitations, remote-environment guidance, and troubleshooting documentation.
- Updated the build and packaging toolchain to audited versions with zero reported npm vulnerabilities.
- Limited VSIX contents to the runtime bundle, extension metadata, documentation, license, and icon.

## 0.0.1

- Initial Phase 1 scaffold for the Codex Thread Manager VS Code extension.
