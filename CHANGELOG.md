# Changelog

## Unreleased

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
