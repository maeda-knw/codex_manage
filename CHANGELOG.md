# Changelog

## Unreleased

- Moved the always-visible Runtime summary below the composer, shortened GPT model names, omitted default markers and non-Fast speed tiers, and added the current sandbox permission.
- Added a workspace-scoped **New conversation** flow that applies validated runtime defaults, creates a thread on the first text send, and transitions directly into its running turn.
- Added duplicate-submit prevention, draft preservation on failure, late-result isolation, notification buffering, and ID-based list deduplication for new conversations.
- Added strict `config/read` and `thread/start` response boundaries plus fake App Server integration coverage for runtime forwarding and malformed responses.
- Fixed Runtime settings changes for conversations with granular approval policies while preserving the host-owned policy unchanged.
- Added an always-visible model and reasoning summary, explicit default, unlisted, and unavailable picker states, plus outside-click and Escape dismissal.
- Fixed partially loaded turn-completion notifications so streamed text remains visible and the conversation automatically converges on authoritative history without a manual reload.
- Added Phase D load regression coverage for thousand-turn histories, long streaming responses, authoritative convergence, and cross-thread isolation.
- Added DOM-level Markdown security tests for inert HTML and blocked unsafe link protocols.
- Added a protocol snapshot drift gate that regenerates all App Server TypeScript types from the pinned Codex CLI during verification.
- Improved forced-colors focus and boundary visibility and added a release evidence matrix for accessibility and remote environments.
- Fixed the Runtime settings popover so it opens above its trigger without shifting the composer controls.
- Fixed runtime model selection to preserve every App Server catalog entry, including GPT-5.6 Sol, Terra, and Luna.
- Added pinned Node.js/npm toolchain metadata, cache-first dependency bootstrap commands, and a dependency doctor that rejects partial npm extractions.
- Added explicit npm install-script decisions so only the required esbuild setup script is allowed during dependency installation.
- Added in-conversation command, file-change, and permission approval cards with one-time and session-scoped decisions.
- Added typed responses for Codex follow-up questions and supported MCP form elicitations.
- Added host-owned request correlation, stale-thread isolation, safe cancellation, and duplicate-response prevention for App Server requests.
- Added vNext Phase B text conversation with `thread/resume`, `turn/start`, streamed agent-message updates, and `turn/interrupt` Stop support.
- Added a sticky sidebar composer with Ctrl/Cmd+Enter sending, double-submit protection, correlated operation results, and draft preservation on failure.
- Added host-owned conversation sessions and an ID-keyed reducer that isolates threads, converges on completed snapshots, and re-synchronizes history after disconnects.
- Added keyed transcript rendering so streaming updates preserve activity-card expansion, focus, and scroll position.
- Added strict response/notification boundaries and fake App Server coverage for resume, start, delta, completion, interrupt, malformed responses, and message-log redaction.
- Added vNext Phase A read-only conversation rendering backed by `thread/read(includeTurns: true)`.
- Added vNext Phase A.5 list/conversation navigation inside one Codex sidebar Webview View, including Back, reload, scroll/selection restoration, and stale-read protection.
- Added vNext Phase A.6 list polish: native view-title actions are no longer duplicated, thread groups are collapsible, full card bodies open conversations, and management uses inline icons.
- Added typed, CSP-protected Webview rendering for stored user/Codex messages, turn state, and summarized work cards.
- Excluded raw reasoning content, command output, file diffs, tool payloads, delegated prompts, and hook fragments from the Webview model.
- Added unit and fake App Server coverage for conversation mapping, sidebar transitions/restoration, operation boundaries, panel races, and CSP.
- Added a view-title settings action beside Refresh Threads for quick access to the extension configuration.
- Added a keyboard-accessible 48px thread-card layout with inline management actions and fixed command allowlisting.
- Added an automated VSIX contents check so both thread-list and conversation Webview assets must be packaged.
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
