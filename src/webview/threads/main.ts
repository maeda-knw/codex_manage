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
  restoreThreadsWebviewState,
  type ThreadListAction,
  type ThreadListGroupId,
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

type ThreadCardAction = 'open' | 'pin' | 'unpin' | 'rename' | 'archive' | 'unarchive';
type ThreadActionIcon = 'pin' | 'unpin' | 'rename' | 'archive' | 'restore';

interface ThreadCardFocus {
  readonly threadId: string;
  readonly action: ThreadCardAction;
  readonly sourceGroupId?: ThreadListGroupId;
}

declare function acquireVsCodeApi<T>(): VsCodeApi<T>;

const vscode = acquireVsCodeApi<ThreadsWebviewState>();
const app = requiredElement<HTMLElement>('app');
let persistedState = restoreThreadsWebviewState(vscode.getState());
let listState: Extract<ThreadsHostToWebviewMessage, { type: 'threads/listState' }> | undefined;
let screen: 'list' | 'conversation' = persistedState.screen;
let conversationTarget: ConversationRenderTarget | undefined;
let conversationThreadId: string | undefined;
let pendingThreadCardFocus: ThreadCardFocus | undefined;
let pendingThreadGroupFocusId: ThreadListGroupId | undefined;
let listRenderGeneration = 0;

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
    pendingThreadCardFocus = undefined;
    pendingThreadGroupFocusId = undefined;
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
    if (threadId && isThreadCardAction(action)) {
      pendingThreadCardFocus = threadCardFocus(element, action, threadId);
      pendingThreadGroupFocusId = undefined;
    } else {
      pendingThreadCardFocus = undefined;
      pendingThreadGroupFocusId = undefined;
    }
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
  const buttons = [...app.querySelectorAll<HTMLButtonElement>('[data-action="open"]')]
    .filter(isVisibleThreadControl);
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
  const renderGeneration = ++listRenderGeneration;
  const activeGroupId = focusedThreadGroupId();
  const activeCardControl = focusedThreadCardControl();
  const focusedGroupId = activeGroupId ?? (activeCardControl ? undefined : pendingThreadGroupFocusId);
  const focusedCardControl = focusedGroupId
    ? undefined
    : activeCardControl ?? pendingThreadCardFocus;
  if (focusedGroupId) {
    pendingThreadGroupFocusId = focusedGroupId;
    pendingThreadCardFocus = undefined;
  } else if (focusedCardControl) {
    pendingThreadCardFocus = focusedCardControl;
    pendingThreadGroupFocusId = undefined;
  }
  screen = 'list';
  conversationTarget = undefined;
  conversationThreadId = undefined;
  app.replaceChildren();
  app.setAttribute('aria-busy', 'false');

  if (!state.hasWorkspace) {
    pendingThreadCardFocus = undefined;
    pendingThreadGroupFocusId = undefined;
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Open a workspace folder to view Codex threads.';
    app.append(empty);
    return;
  }

  appendGroup('pinned', 'Pinned', state.snapshot.pinned);
  appendGroup('active', 'Recent threads', state.snapshot.active, 'loadMoreActive');
  appendGroup('archive', 'Archive', state.snapshot.archive, 'loadMoreArchive');

  const scrollTop = persistedState.listScrollTop;
  const selectedThreadId = persistedState.selectedThreadId;
  requestAnimationFrame(() => {
    if (screen !== 'list' || renderGeneration !== listRenderGeneration) {
      return;
    }
    window.scrollTo({ top: scrollTop });
    if (focusedGroupId) {
      app.querySelector<HTMLElement>(
        `.thread-group > summary[data-group-id="${focusedGroupId}"]`
      )?.focus({ preventScroll: true });
      if (pendingThreadGroupFocusId === focusedGroupId) {
        pendingThreadGroupFocusId = undefined;
      }
      return;
    }
    if (focusedCardControl && restoreThreadCardFocus(focusedCardControl)) {
      clearPendingThreadCardFocus(focusedCardControl);
      return;
    }
    if (focusedCardControl) {
      clearPendingThreadCardFocus(focusedCardControl);
    }
    if (selectedThreadId) {
      const selected = app.querySelector<HTMLButtonElement>(
        `[data-action="open"][data-thread-id="${cssEscape(selectedThreadId)}"]`
      );
      if (selected && isVisibleThreadControl(selected)) {
        selected.focus({ preventScroll: true });
      }
    }
  });

  function appendGroup(
    groupId: ThreadListGroupId,
    label: string,
    group: ThreadListPageViewModel,
    loadMoreAction?: 'loadMoreActive' | 'loadMoreArchive'
  ): void {
    const section = document.createElement('details');
    section.className = 'thread-group';
    section.dataset.groupId = groupId;
    section.open = persistedState.expandedGroups[groupId];
    const summary = document.createElement('summary');
    summary.dataset.groupId = groupId;
    const heading = document.createElement('h2');
    heading.textContent = label;
    summary.append(heading);
    const content = document.createElement('div');
    content.className = 'thread-group-content';

    for (const thread of group.threads) {
      content.append(renderThreadCard(thread));
    }
    if (group.threads.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'group-empty';
      empty.textContent = state.status.kind === 'error'
        ? state.status.message
        : group.loaded
          ? 'No threads in this group.'
          : 'Loading…';
      content.append(empty);
    }
    if (group.nextCursor && loadMoreAction) {
      const more = actionButton('Load more…', loadMoreAction);
      more.className = 'load-more';
      content.append(more);
    }
    section.append(summary, content);
    section.addEventListener('toggle', () => {
      persistState({
        expandedGroups: {
          ...persistedState.expandedGroups,
          [groupId]: section.open
        }
      });
    });
    app.append(section);
  }
}

function renderThreadCard(thread: ThreadListItemViewModel): HTMLElement {
  const card = document.createElement('article');
  card.className = 'thread-card';
  const open = actionButton('', 'open', thread.id);
  open.className = 'thread-open';
  open.dataset.threadTitle = thread.title;
  open.setAttribute('aria-label', `Open conversation: ${thread.title}, ${thread.description}`);
  const title = document.createElement('span');
  title.className = 'thread-title';
  title.textContent = thread.title;
  const meta = document.createElement('span');
  meta.className = 'thread-meta';
  meta.textContent = thread.description;
  open.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'thread-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', `Actions for ${thread.title}`);

  if (thread.archived) {
    card.classList.add('thread-card--single-action');
    actions.append(threadActionButton('Restore', 'unarchive', 'restore', thread));
  } else {
    actions.append(
      thread.pinned
        ? threadActionButton('Unpin', 'unpin', 'unpin', thread)
        : threadActionButton('Pin', 'pin', 'pin', thread),
      threadActionButton('Rename', 'rename', 'rename', thread),
      threadActionButton('Archive', 'archive', 'archive', thread)
    );
  }
  card.append(open, actions);
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
  persistedState = { ...persistedState, ...update, version: 2 };
  vscode.setState(persistedState);
}

function isVisibleThreadControl(control: HTMLElement): boolean {
  return control.closest<HTMLDetailsElement>('.thread-group')?.open !== false;
}

function focusedThreadGroupId(): ThreadListGroupId | undefined {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.matches('.thread-group > summary')) {
    return undefined;
  }
  const groupId = focused.dataset.groupId;
  return isThreadListGroupId(groupId) ? groupId : undefined;
}

function isThreadListGroupId(value: string | undefined): value is ThreadListGroupId {
  return value === 'pinned' || value === 'active' || value === 'archive';
}

function focusedThreadCardControl(): ThreadCardFocus | undefined {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLButtonElement)) {
    return undefined;
  }
  const { action, threadId } = focused.dataset;
  return isThreadCardAction(action) && threadId
    ? threadCardFocus(focused, action, threadId)
    : undefined;
}

function threadCardFocus(
  control: HTMLElement,
  action: ThreadCardAction,
  threadId: string
): ThreadCardFocus {
  const groupId = control.closest<HTMLDetailsElement>('.thread-group')?.dataset.groupId;
  return isThreadListGroupId(groupId)
    ? { action, threadId, sourceGroupId: groupId }
    : { action, threadId };
}

function restoreThreadCardFocus(focus: ThreadCardFocus): boolean {
  const threadId = cssEscape(focus.threadId);
  const actions = focus.action === 'pin'
    ? ['pin', 'unpin']
    : focus.action === 'unpin'
      ? ['unpin', 'pin']
      : focus.action === 'archive'
        ? ['archive', 'unarchive']
        : focus.action === 'unarchive'
          ? ['unarchive', 'archive']
          : [focus.action];

  for (const action of actions) {
    const control = app.querySelector<HTMLButtonElement>(
      `[data-action="${action}"][data-thread-id="${threadId}"]`
    );
    if (control && isVisibleThreadControl(control)) {
      focusRestoredControl(control);
      return true;
    }
  }

  const open = app.querySelector<HTMLButtonElement>(
    `[data-action="open"][data-thread-id="${threadId}"]`
  );
  if (!open) {
    return focus.sourceGroupId ? focusGroupSummary(focus.sourceGroupId) : false;
  }
  if (isVisibleThreadControl(open)) {
    focusRestoredControl(open);
    return true;
  }
  const targetGroupId = open.closest<HTMLDetailsElement>('.thread-group')?.dataset.groupId;
  return isThreadListGroupId(targetGroupId)
    ? focusGroupSummary(targetGroupId)
    : focus.sourceGroupId
      ? focusGroupSummary(focus.sourceGroupId)
      : false;
}

function focusGroupSummary(groupId: ThreadListGroupId): boolean {
  const summary = app.querySelector<HTMLElement>(
    `.thread-group[data-group-id="${groupId}"] > summary`
  );
  if (!summary) {
    return false;
  }
  focusRestoredControl(summary);
  return true;
}

function focusRestoredControl(control: HTMLElement): void {
  control.focus({ preventScroll: true });
  control.scrollIntoView({ block: 'nearest' });
}

function clearPendingThreadCardFocus(restored: ThreadCardFocus): void {
  if (
    pendingThreadCardFocus?.threadId === restored.threadId &&
    pendingThreadCardFocus.action === restored.action &&
    pendingThreadCardFocus.sourceGroupId === restored.sourceGroupId
  ) {
    pendingThreadCardFocus = undefined;
  }
}

function isThreadCardAction(value: string | undefined): value is ThreadCardAction {
  return ['open', 'pin', 'unpin', 'rename', 'archive', 'unarchive'].includes(value ?? '');
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

function threadActionButton(
  label: string,
  action: Exclude<ThreadCardAction, 'open'>,
  icon: ThreadActionIcon,
  thread: ThreadListItemViewModel
): HTMLButtonElement {
  const result = actionButton('', action, thread.id);
  result.className = 'thread-action';
  result.setAttribute('aria-label', `${label} ${thread.title}`);
  result.title = `${label} ${thread.title}`;
  result.append(threadActionIcon(icon));
  return result;
}

function threadActionIcon(icon: ThreadActionIcon): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const result = document.createElementNS(namespace, 'svg');
  result.classList.add('thread-action-icon');
  result.setAttribute('viewBox', '0 0 16 16');
  result.setAttribute('fill', 'none');
  result.setAttribute('stroke', 'currentColor');
  result.setAttribute('stroke-width', '1.25');
  result.setAttribute('stroke-linecap', 'round');
  result.setAttribute('stroke-linejoin', 'round');
  result.setAttribute('aria-hidden', 'true');
  result.setAttribute('focusable', 'false');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', THREAD_ACTION_ICON_PATHS[icon]);
  result.append(path);
  return result;
}

const THREAD_ACTION_ICON_PATHS: Readonly<Record<ThreadActionIcon, string>> = {
  pin: 'M6 2.5h4l.5 4 2 2.5h-9l2-2.5.5-4M8 9v4.5',
  unpin: 'M6 2.5h4l.5 4 2 2.5h-9l2-2.5.5-4M8 9v4.5M2.5 2.5l11 11',
  rename: 'M3 12.5l.5-2L11 3l2 2-7.5 7.5-2 .5ZM9.8 4.2l2 2',
  archive: 'M2.5 3.5h11V6h-11ZM3.5 6v7h9V6M6 8.5h4',
  restore: 'M2.5 5.5V2.8M2.5 5.5h2.7M2.5 5.5a5.5 5.5 0 1 1 .3 5.7'
};

function isThreadListAction(value: string | undefined): value is ThreadListAction {
  return [
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
