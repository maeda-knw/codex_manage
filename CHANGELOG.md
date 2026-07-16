# Changelog

## Unreleased

- Added the Phase 2 Codex App Server stdio client and generated protocol snapshot.
- Added a read-only workspace-scoped `thread/list` connection probe and connection diagnostics.
- Limited VSIX contents to the runtime bundle, extension metadata, documentation, license, and icon.
- Added native and official npm Codex CLI resolution without shell execution, including Windows shim manifest validation.
- Added runtime/generated CLI version diagnostics and behavior-based compatibility checks for required App Server boundaries.
- Pinned the protocol-generation CLI exactly and added resolver, compatibility, and opt-in real CLI smoke tests.

## 0.0.1

- Initial Phase 1 scaffold for the Codex Thread Manager VS Code extension.
