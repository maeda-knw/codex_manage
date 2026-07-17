import '../conversation/styles.css';
import './styles.css';
import type { ConversationViewModel } from '../../conversation/conversationViewModel';
import {
  renderConversation,
  renderConversationError,
  renderConversationLoading,
  type ConversationRenderTarget
} from '../conversation/render';
import {
  isThreadsHostMessage,
  isThreadsWebviewState,
  type ThreadListAction,
  type ThreadListItemViewModel,
  type ThreadListPageViewModel,
  type ThreadsHostToWebviewMessage,
  type ThreadsWebviewState
} from './protocol';

interface VsCodeApi<T> {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
}

declare function acquireVsCodeApi<T>(): VsCodeApi<T>;

const vscode = acquireVsCodeApi<ThreadsWebviewState>();
const app = requiredElement<HTMLElement>('app');
const restoredState = vscode.getState();
let persistedState: ThreadsWebviewState = isThreadsWebviewState(restoredState)
  ? restoredState
  : { version: 1, screen: 'list', selectedThreadId: null, listScrollTop: 0 };
let listState: Extract<ThreadsHostToWebviewMessage, { type: 'threads/listState' }> | undefined;
let screen: 'list' | 'conversation' = persistedState.screen;
let conversationTarget: ConversationRenderTarget | undefined;
let conversationThreadId: string | undefined;

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isThreadsHostMessage(event.data)) {
    return;
  }
  handleHostMessage(event.data);
});

window.addEventListener('scroll', () => {
  if (screen === 'list') {
    persistState({ listScrollTop: window.scrollY });
  }
}, { passive: true });

app.addEventListener('click', (event) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!element) {
    return;
  }
  const action = element.dataset.action;
  const threadId = element.dataset.threadId;
  if (action === 'open' && threadId) {
    persistState({
      screen: 'conversation',
      selectedThreadId: threadId,
      listScrollTop: window.scrollY
    });
    const title = element.dataset.threadTitle ?? 'Codex thread';
    showConversationShell(threadId, title, true);
    renderConversationLoading(requireConversationTarget(), title);
    vscode.postMessage({ type: 'threads/open', threadId });
    return;
  }
  if (action === 'back') {
    vscode.postMessage({ type: 'threads/back' });
    return;
  }
  if (action === 'reload') {
    vscode.postMessage({ type: 'threads/reload' });
    return;
  }
  if (isThreadListAction(action)) {
    vscode.postMessage({ type: 'threads/action', action, threadId });
  }
});

app.addEventListener('keydown', (event) => {
  if (!(event instanceof KeyboardEvent) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    return;
  }
  const current = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action="open"]');
  if (!current) {
    return;
  }
  const buttons = [...app.querySelectorAll<HTMLButtonElement>('[data-action="open"]')];
  const currentIndex = buttons.indexOf(current);
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? buttons.length - 1
      : Math.min(
        buttons.length - 1,
        Math.max(0, currentIndex + (event.key === 'ArrowDown' ? 1 : -1))
      );
  if (nextIndex !== currentIndex) {
    event.preventDefault();
    buttons[nextIndex]?.focus();
  }
});

vscode.postMessage({ type: 'threads/ready' });

function handleHostMessage(message: ThreadsHostToWebviewMessage): void {
  switch (message.type) {
    case 'threads/listState':
      listState = message;
      if (screen === 'list') {
        renderList(message);
      }
      return;
    case 'threads/showList':
      screen = 'list';
      persistState({ screen: 'list' });
      if (listState) {
        renderList(listState);
      }
      return;
    case 'threads/conversationLoading':
      showConversationShell(message.threadId, message.title, true);
      renderConversationLoading(requireConversationTarget(), message.title);
      return;
    case 'threads/conversationLoaded':
      showConversationShell(message.model.threadId, message.model.title);
      renderConversation(requireConversationTarget(), message.model);
      persistConversation(message.model);
      return;
    case 'threads/conversationError':
      showConversationShell(message.threadId, message.title);
      renderConversationError(requireConversationTarget(), message.message, message.title);
  }
}

function renderList(state: Extract<ThreadsHostToWebviewMessage, { type: 'threads/listState' }>): void {
  screen = 'list';
  conversationTarget = undefined;
  conversationThreadId = undefined;
  app.replaceChildren();
  app.setAttribute('aria-busy', 'false');

  if (!state.hasWorkspace) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Open a workspace folder to view Codex threads.';
    app.append(empty);
    return;
  }

  const header = document.createElement('header');
  header.className = 'list-header';
  const title = document.createElement('strong');
  title.textContent = 'Codex threads';
  const actions = document.createElement('div');
  actions.className = 'list-header-actions';
  actions.append(
    actionButton('Refresh', 'refresh'),
    actionButton('Settings', 'openSettings')
  );
  header.append(title, actions);
  app.append(header);

  appendGroup('Pinned', state.snapshot.pinned);
  appendGroup('Recent threads', state.snapshot.active, 'loadMoreActive');
  appendGroup('Archive', state.snapshot.archive, 'loadMoreArchive');

  const scrollTop = persistedState.listScrollTop;
  const selectedThreadId = persistedState.selectedThreadId;
  requestAnimationFrame(() => {
    window.scrollTo({ top: scrollTop });
    if (selectedThreadId) {
      app.querySelector<HTMLButtonElement>(
        `[data-action="open"][data-thread-id="${cssEscape(selectedThreadId)}"]`
      )?.focus({ preventScroll: true });
    }
  });

  function appendGroup(
    label: string,
    group: ThreadListPageViewModel,
    loadMoreAction?: 'loadMoreActive' | 'loadMoreArchive'
  ): void {
    const section = document.createElement('section');
    section.className = 'thread-group';
    const heading = document.createElement('h2');
    heading.textContent = label;
    section.append(heading);

    for (const thread of group.threads) {
      section.append(renderThreadCard(thread));
    }
    if (group.threads.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'group-empty';
      empty.textContent = state.status.kind === 'error'
        ? state.status.message
        : group.loaded
          ? 'No threads in this group.'
          : 'Loading…';
      section.append(empty);
    }
    if (group.nextCursor && loadMoreAction) {
      const more = actionButton('Load more…', loadMoreAction);
      more.className = 'load-more';
      section.append(more);
    }
    app.append(section);
  }
}

function renderThreadCard(thread: ThreadListItemViewModel): HTMLElement {
  const card = document.createElement('article');
  card.className = 'thread-card';
  const open = actionButton(thread.title, 'open', thread.id);
  open.className = 'thread-title';
  open.dataset.threadTitle = thread.title;
  open.setAttribute('aria-label', `Open conversation: ${thread.title}, ${thread.description}`);
  const meta = document.createElement('div');
  meta.className = 'thread-meta';
  meta.textContent = thread.description;
  const menu = document.createElement('details');
  menu.className = 'thread-menu';
  const menuTrigger = document.createElement('summary');
  menuTrigger.textContent = '…';
  menuTrigger.setAttribute('aria-label', `Manage thread: ${thread.title}`);
  menuTrigger.title = `Manage ${thread.title}`;
  const actions = document.createElement('div');
  actions.className = 'thread-menu-actions';
  const primaryAction = thread.archived
    ? actionButton('Restore', 'unarchive', thread.id)
    : thread.pinned
      ? actionButton('Unpin', 'unpin', thread.id)
      : actionButton('Pin', 'pin', thread.id);
  primaryAction.setAttribute('aria-label', `${primaryAction.textContent ?? 'Manage'} ${thread.title}`);
  actions.append(primaryAction);
  if (!thread.archived) {
    const rename = actionButton('Rename', 'rename', thread.id);
    const archive = actionButton('Archive', 'archive', thread.id);
    rename.setAttribute('aria-label', `Rename ${thread.title}`);
    archive.setAttribute('aria-label', `Archive ${thread.title}`);
    actions.append(rename, archive);
  }
  menu.append(menuTrigger, actions);
  card.append(open, meta, menu);
  return card;
}

function showConversationShell(threadId: string, title: string, focusBack = false): void {
  screen = 'conversation';
  persistState({ screen: 'conversation', selectedThreadId: threadId });

  if (conversationTarget && conversationThreadId === threadId) {
    conversationTarget.title.textContent = title;
    app.querySelector<HTMLButtonElement>('[data-action="reload"]')?.setAttribute(
      'aria-label',
      `Reload conversation: ${title}`
    );
    return;
  }

  app.replaceChildren();
  app.setAttribute('aria-busy', 'false');
  conversationThreadId = threadId;

  const section = document.createElement('section');
  section.className = 'conversation-view';
  const header = document.createElement('header');
  header.className = 'conversation-header';
  const back = actionButton('Back', 'back');
  back.className = 'back-button';
  back.setAttribute('aria-label', 'Back to thread list');
  const heading = document.createElement('div');
  heading.className = 'conversation-heading';
  const titleElement = document.createElement('h1');
  titleElement.textContent = title;
  const meta = document.createElement('p');
  meta.className = 'muted conversation-meta';
  heading.append(titleElement, meta);
  const reload = actionButton('Reload', 'reload');
  reload.className = 'reload-button';
  reload.setAttribute('aria-label', `Reload conversation: ${title}`);
  header.append(back, heading, reload);

  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const content = document.createElement('div');
  content.className = 'conversation-content';
  content.setAttribute('aria-live', 'polite');
  section.append(header, notice, content);
  app.append(section);
  conversationTarget = { title: titleElement, meta, notice, content };
  if (focusBack) {
    requestAnimationFrame(() => back.focus());
  }
}

function persistConversation(model: ConversationViewModel): void {
  persistState({
    screen: 'conversation',
    selectedThreadId: model.threadId
  });
}

function persistState(update: Partial<Omit<ThreadsWebviewState, 'version'>>): void {
  persistedState = { ...persistedState, ...update, version: 1 };
  vscode.setState(persistedState);
}

function requireConversationTarget(): ConversationRenderTarget {
  if (!conversationTarget) {
    throw new Error('Conversation render target is unavailable.');
  }
  return conversationTarget;
}

function actionButton(
  label: string,
  action: ThreadListAction | 'open' | 'back' | 'reload',
  threadId?: string
): HTMLButtonElement {
  const result = document.createElement('button');
  result.type = 'button';
  result.textContent = label;
  result.dataset.action = action;
  if (threadId) {
    result.dataset.threadId = threadId;
  }
  return result;
}

function isThreadListAction(value: string | undefined): value is ThreadListAction {
  return [
    'refresh',
    'openSettings',
    'loadMoreActive',
    'loadMoreArchive',
    'pin',
    'unpin',
    'rename',
    'archive',
    'unarchive'
  ].includes(value ?? '');
}

function cssEscape(value: string): string {
  return CSS.escape(value);
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}
