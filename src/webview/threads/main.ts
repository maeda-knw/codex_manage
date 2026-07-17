import type { ThreadsHostToWebviewMessage } from './protocol';
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const root = document.querySelector<HTMLElement>('#threads')!;
window.addEventListener('message', (event: MessageEvent<unknown>) => { const message = event.data as ThreadsHostToWebviewMessage; if (message?.type === 'threads/state') render(message); });
root.addEventListener('click', (event) => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-command]'); if (target) vscode.postMessage({ type: 'threads/command', command: target.dataset.command, threadId: target.dataset.threadId }); });
vscode.postMessage({ type: 'threads/ready' });
function render(state: ThreadsHostToWebviewMessage): void {
  root.replaceChildren(); root.setAttribute('aria-busy', 'false');
  if (!state.hasWorkspace) { root.textContent = 'Open a workspace folder to view Codex threads.'; return; }
  const header = document.createElement('header'); header.innerHTML = '<strong>Codex threads</strong> ';
  header.append(button('Refresh', 'refresh'), button('Settings', 'settings')); root.append(header);
  for (const [name, group, more] of [['Pinned', state.snapshot.pinned, undefined], ['Recent threads', state.snapshot.active, 'loadMoreActive'], ['Archive', state.snapshot.archive, 'loadMoreArchive']] as const) {
    const section = document.createElement('section'); const title = document.createElement('h2'); title.textContent = name; section.append(title);
    for (const thread of group.threads) { const card = document.createElement('article'); card.tabIndex = 0; card.className = 'thread-card'; const open = button(thread.title, 'open', thread.id); open.className = 'thread-title'; card.append(open); const meta = document.createElement('div'); meta.textContent = thread.description; card.append(meta); card.append(button(thread.archived ? 'Restore' : thread.pinned ? 'Unpin' : 'Pin', thread.archived ? 'unarchive' : thread.pinned ? 'unpin' : 'pin', thread.id)); if (!thread.archived) { card.append(button('Rename', 'rename', thread.id), button('Archive', 'archive', thread.id)); } section.append(card); }
    if (!group.threads.length) { const empty = document.createElement('p'); empty.textContent = state.status.kind === 'error' ? state.status.message : 'No threads in this group.'; section.append(empty); }
    if (group.nextCursor && more) section.append(button('Load more…', more)); root.append(section);
  }
}
function button(label: string, command: string, threadId?: string): HTMLButtonElement { const result = document.createElement('button'); result.type = 'button'; result.textContent = label; result.dataset.command = command; if (threadId) result.dataset.threadId = threadId; return result; }
