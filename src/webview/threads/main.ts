import '../conversation/styles.css';
import './styles.css';
import type { ConversationViewModel } from '../../conversation/conversationViewModel';
import type { ConversationInteractionViewModel } from '../../conversation/conversationInteraction';
import {
  renderConversation,
  renderConversationError,
  renderConversationLoading,
  type ConversationRenderTarget
} from '../conversation/render';
import {
  MAX_COMPOSER_TEXT_LENGTH,
  isThreadsHostMessage,
  restoreThreadsWebviewState,
  type ConversationExecutionViewModel,
  type ConversationOperationResult,
  type ConversationScreenState,
  type ThreadListAction,
  type ThreadListGroupId,
  type ThreadListItemViewModel,
  type ThreadListPageViewModel,
  type ThreadsHostToWebviewMessage,
  type ThreadsWebviewState
} from './protocol';
import { defaultRuntimeLabel, runtimeSettingsSummary } from './runtimeSettings';

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

interface ConversationComposerTarget {
  readonly container: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly send: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly error: HTMLElement;
  readonly announcer: HTMLElement;
  readonly add: HTMLButtonElement;
  readonly addMenu: HTMLElement;
  readonly settings: HTMLDetailsElement;
  readonly settingsSummary: HTMLElement;
  readonly runtimeSummary: HTMLElement;
  readonly model: HTMLSelectElement;
  readonly effort: HTMLSelectElement;
  readonly serviceTier: HTMLSelectElement;
  readonly sandbox: HTMLSelectElement;
  readonly approvalPolicy: HTMLSelectElement;
}

interface PendingConversationSend {
  readonly requestId: string;
  readonly text: string;
}

declare function acquireVsCodeApi<T>(): VsCodeApi<T>;

const vscode = acquireVsCodeApi<ThreadsWebviewState>();
const app = requiredElement<HTMLElement>('app');
let persistedState = restoreThreadsWebviewState(vscode.getState());
let listState: Extract<ThreadsHostToWebviewMessage, { type: 'threads/listState' }> | undefined;
let screen: 'list' | 'conversation' = persistedState.screen;
let conversationTarget: ConversationRenderTarget | undefined;
let conversationComposerTarget: ConversationComposerTarget | undefined;
let conversationInteractionsTarget: HTMLElement | undefined;
let conversationThreadId: string | undefined;
let conversationSessionId: string | undefined;
let conversationScreenState: ConversationScreenState | undefined;
let pendingConversationState: ConversationScreenState | undefined;
let pendingConversationFrame: number | undefined;
let lastConversationRevision = -1;
let hasRenderedConversation = false;
let lastAnnouncedCompletedTurnId: string | undefined;
let pendingConversationSend: PendingConversationSend | undefined;
let pendingConversationStopRequestId: string | undefined;
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
    showConversationShell(threadId, title, false);
    renderConversationLoading(requireConversationTarget(), title);
    vscode.postMessage({ type: 'threads/open', threadId });
    return;
  }
  if (action === 'new') {
    pendingThreadCardFocus = undefined;
    pendingThreadGroupFocusId = undefined;
    vscode.postMessage({ type: 'threads/new' });
    return;
  }
  if (action === 'stop') {
    stopConversation();
    return;
  }
  if (action === 'send') {
    submitConversation();
    return;
  }
  if (action === 'add') {
    toggleAddMenu();
    return;
  }
  if (action?.startsWith('interaction-')) {
    submitInteraction(element, action.slice('interaction-'.length));
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

document.addEventListener('click', (event) => {
  const target = conversationComposerTarget;
  if (
    target?.settings.open &&
    event.target instanceof Node &&
    !target.settings.contains(event.target)
  ) {
    target.settings.open = false;
  }
});

app.addEventListener('keydown', (event) => {
  if (!(event instanceof KeyboardEvent)) {
    return;
  }
  if (event.key === 'Escape' && conversationComposerTarget?.settings.open) {
    event.preventDefault();
    event.stopPropagation();
    closeRuntimeSettings(true);
    return;
  }
  if (
    event.target === conversationComposerTarget?.input &&
    event.key === 'Enter' &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    submitConversation();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
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

app.addEventListener('input', (event) => {
  if (event.target === conversationComposerTarget?.input) {
    updateConversationComposer();
  }
});

app.addEventListener('change', (event) => {
  const target = conversationComposerTarget;
  if (!target || !(event.target instanceof HTMLSelectElement) || !target.settings.contains(event.target)) {
    return;
  }
  submitRuntimeSettings(event.target === target.model);
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
      resetConversationContext();
      persistState({ screen: 'list' });
      if (listState) {
        renderList(listState);
      }
      return;
    case 'threads/conversationLoading':
      if (
        conversationThreadId !== message.threadId &&
        !(
          !conversationThreadId &&
          screen === 'conversation' &&
          persistedState.selectedThreadId === message.threadId
        )
      ) {
        return;
      }
      showConversationShell(message.threadId, message.title, false, message.sessionId);
      renderConversationLoading(
        requireConversationTarget(),
        message.title,
        hasRenderedConversation
      );
      updateConversationComposer();
      return;
    case 'threads/conversationLoaded':
    case 'threads/conversationState':
      queueConversationState(message.state);
      return;
    case 'threads/newConversationLoaded':
      showConversationShell(
        message.state.model.threadId,
        message.state.model.title,
        false,
        message.state.sessionId
      );
      queueConversationState(message.state);
      return;
    case 'threads/conversationCreated':
      if (!isActiveConversation(message.state.sessionId, message.previousThreadId)) {
        return;
      }
      conversationThreadId = message.state.model.threadId;
      persistState({
        screen: 'conversation',
        selectedThreadId: message.state.model.threadId
      });
      if (conversationTarget) conversationTarget.title.textContent = message.state.model.title;
      queueConversationState(message.state);
      return;
    case 'threads/conversationError':
      if (!isActiveConversation(message.sessionId, message.threadId)) {
        return;
      }
      renderConversationError(
        requireConversationTarget(),
        message.message,
        message.title,
        hasRenderedConversation
      );
      showConversationOperationError(message.message);
      updateConversationComposer();
      return;
    case 'threads/conversationOperationResult':
      handleConversationOperationResult(message);
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
  resetConversationContext();
  app.replaceChildren();
  app.setAttribute('aria-live', 'polite');
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

  const listToolbar = document.createElement('div');
  listToolbar.className = 'thread-list-toolbar';
  const newConversation = actionButton('＋ New conversation', 'new');
  newConversation.className = 'new-conversation';
  newConversation.disabled = state.status.kind !== 'ready';
  newConversation.title = state.status.kind === 'ready'
    ? 'Start a new conversation in this workspace'
    : 'Connect to Codex before starting a conversation';
  listToolbar.append(newConversation);
  app.append(listToolbar);

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

function showConversationShell(
  threadId: string,
  title: string,
  focusBack = false,
  sessionId?: string
): void {
  screen = 'conversation';
  persistState({ screen: 'conversation', selectedThreadId: threadId });

  if (conversationTarget && conversationThreadId === threadId) {
    conversationTarget.title.textContent = title;
    app.querySelector<HTMLButtonElement>('[data-action="reload"]')?.setAttribute(
      'aria-label',
      `Reload conversation: ${title}`
    );
    if (sessionId && sessionId !== conversationSessionId) {
      beginConversationSession(sessionId);
    }
    if (focusBack) {
      focusConversationBackButton();
    }
    return;
  }

  resetConversationContext();
  app.replaceChildren();
  app.removeAttribute('aria-live');
  app.setAttribute('aria-busy', 'false');
  conversationThreadId = threadId;
  conversationSessionId = sessionId;

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
  content.setAttribute('aria-label', 'Conversation transcript');
  const interactions = document.createElement('section');
  interactions.className = 'conversation-interactions';
  interactions.setAttribute('aria-label', 'Requests requiring your attention');
  const announcer = document.createElement('div');
  announcer.className = 'sr-only';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');

  const composer = document.createElement('div');
  composer.className = 'conversation-composer';
  composer.setAttribute('role', 'group');
  composer.setAttribute('aria-label', 'Message Codex');
  const tools = document.createElement('div');
  tools.className = 'conversation-composer-tools';
  const add = actionButton('＋ Add', 'add');
  add.className = 'conversation-add';
  add.setAttribute('aria-haspopup', 'menu');
  add.setAttribute('aria-expanded', 'false');
  const addWrap = document.createElement('div');
  addWrap.className = 'conversation-add-wrap';
  const addMenu = document.createElement('div');
  addMenu.className = 'conversation-add-menu';
  addMenu.setAttribute('role', 'menu');
  addMenu.hidden = true;
  const addEmpty = document.createElement('p');
  addEmpty.textContent = 'No additional context inputs are available yet.';
  addMenu.append(addEmpty);
  addWrap.append(add, addMenu);

  const settings = document.createElement('details');
  settings.className = 'conversation-runtime-settings';
  const settingsSummary = document.createElement('summary');
  const settingsLabel = document.createElement('span');
  settingsLabel.className = 'conversation-runtime-label';
  settingsLabel.textContent = 'Runtime';
  settingsSummary.append(settingsLabel);
  settings.addEventListener('toggle', () => {
    if (settings.open) {
      addMenu.hidden = true;
      add.setAttribute('aria-expanded', 'false');
    }
  });
  const settingsGrid = document.createElement('div');
  settingsGrid.className = 'conversation-runtime-grid';
  const settingsMenu = document.createElement('div');
  settingsMenu.className = 'conversation-runtime-menu';
  const model = runtimeSelect('Model', 'conversation-runtime-model');
  const effort = runtimeSelect('Reasoning', 'conversation-runtime-effort');
  const serviceTier = runtimeSelect('Speed', 'conversation-runtime-speed');
  const sandbox = runtimeSelect('Sandbox', 'conversation-runtime-sandbox');
  const approvalPolicy = runtimeSelect('Approvals', 'conversation-runtime-approvals');
  settingsGrid.append(model.container, effort.container, serviceTier.container, sandbox.container, approvalPolicy.container);
  const settingsHint = document.createElement('p');
  settingsHint.className = 'conversation-runtime-hint';
  settingsHint.textContent = 'Changes apply to the next turn.';
  settingsMenu.append(settingsGrid, settingsHint);
  settings.append(settingsSummary, settingsMenu);
  tools.append(addWrap, settings);
  const inputLabel = document.createElement('label');
  inputLabel.className = 'sr-only';
  inputLabel.htmlFor = 'conversation-composer-input';
  inputLabel.textContent = 'Message Codex';
  const input = document.createElement('textarea');
  input.id = 'conversation-composer-input';
  input.className = 'conversation-composer-input';
  input.rows = 3;
  input.maxLength = MAX_COMPOSER_TEXT_LENGTH;
  input.placeholder = 'Message Codex…';
  input.setAttribute('aria-describedby', 'conversation-composer-status conversation-composer-error');

  const error = document.createElement('p');
  error.id = 'conversation-composer-error';
  error.className = 'conversation-composer-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const footer = document.createElement('div');
  footer.className = 'conversation-composer-footer';
  const footerMeta = document.createElement('div');
  footerMeta.className = 'conversation-composer-meta';
  const runtimeSummary = document.createElement('span');
  runtimeSummary.className = 'conversation-runtime-summary';
  runtimeSummary.textContent = 'Loading settings…';
  const status = document.createElement('span');
  status.id = 'conversation-composer-status';
  status.className = 'conversation-composer-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const controls = document.createElement('div');
  controls.className = 'conversation-composer-controls';
  const stop = actionButton('Stop', 'stop');
  stop.className = 'conversation-stop';
  stop.setAttribute('aria-label', 'Stop the active Codex turn');
  stop.hidden = true;
  const send = actionButton('Send', 'send');
  send.className = 'conversation-send';
  send.title = 'Send (Ctrl/Cmd+Enter)';
  controls.append(stop, send);
  footerMeta.append(runtimeSummary, status);
  footer.append(footerMeta, controls);
  composer.append(tools, inputLabel, input, error, footer);

  section.append(header, notice, content, interactions, announcer, composer);
  app.append(section);
  conversationTarget = { title: titleElement, meta, notice, content };
  conversationComposerTarget = {
    container: composer, input, send, stop, status, error, announcer,
    add, addMenu, settings, settingsSummary, runtimeSummary,
    model: model.select,
    effort: effort.select,
    serviceTier: serviceTier.select,
    sandbox: sandbox.select,
    approvalPolicy: approvalPolicy.select
  };
  conversationInteractionsTarget = interactions;
  updateConversationComposer();
  if (focusBack) {
    requestAnimationFrame(() => back.focus({ preventScroll: true }));
  }
}

function persistConversation(model: ConversationViewModel): void {
  persistState({
    screen: 'conversation',
    selectedThreadId: model.threadId
  });
}

function beginConversationSession(sessionId: string): void {
  if (pendingConversationFrame !== undefined) {
    cancelAnimationFrame(pendingConversationFrame);
    pendingConversationFrame = undefined;
  }
  conversationSessionId = sessionId;
  conversationScreenState = undefined;
  pendingConversationState = undefined;
  lastConversationRevision = -1;
  lastAnnouncedCompletedTurnId = undefined;
  pendingConversationSend = undefined;
  pendingConversationStopRequestId = undefined;
  clearConversationOperationError();
  updateConversationComposer();
}

function resetConversationContext(): void {
  if (pendingConversationFrame !== undefined) {
    cancelAnimationFrame(pendingConversationFrame);
  }
  conversationTarget = undefined;
  conversationComposerTarget = undefined;
  conversationInteractionsTarget = undefined;
  conversationThreadId = undefined;
  conversationSessionId = undefined;
  conversationScreenState = undefined;
  pendingConversationState = undefined;
  pendingConversationFrame = undefined;
  lastConversationRevision = -1;
  hasRenderedConversation = false;
  lastAnnouncedCompletedTurnId = undefined;
  pendingConversationSend = undefined;
  pendingConversationStopRequestId = undefined;
}

function queueConversationState(state: ConversationScreenState): void {
  if (
    !isActiveConversation(state.sessionId, state.model.threadId) ||
    state.revision <= lastConversationRevision
  ) {
    return;
  }
  lastConversationRevision = state.revision;
  conversationScreenState = state;
  pendingConversationState = state;
  persistConversation(state.model);
  updateConversationComposer();
  if (pendingConversationFrame === undefined) {
    pendingConversationFrame = requestAnimationFrame(renderPendingConversationState);
  }
}

function renderPendingConversationState(): void {
  pendingConversationFrame = undefined;
  const state = pendingConversationState;
  pendingConversationState = undefined;
  if (!state || !isActiveConversation(state.sessionId, state.model.threadId)) {
    return;
  }

  const initialRender = !hasRenderedConversation;
  const followLatest = initialRender || isNearConversationBottom();
  const target = requireConversationTarget();
  renderConversation(target, state.model);
  if (conversationInteractionsTarget) renderConversationInteractions(conversationInteractionsTarget, state.interactions);
  announceCompletedConversationTurn(state.model, initialRender);
  if (state.notice?.trim()) {
    target.notice.hidden = false;
    target.notice.className = 'notice';
    target.notice.textContent = state.notice;
  }
  app.querySelector<HTMLButtonElement>('[data-action="reload"]')?.setAttribute(
    'aria-label',
    `Reload conversation: ${state.model.title}`
  );
  hasRenderedConversation = true;
  if (followLatest) {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }
  if (initialRender) {
    requestAnimationFrame(() => {
      const composer = conversationComposerTarget;
      if (
        composer &&
        !composer.input.disabled &&
        (document.activeElement === document.body || document.activeElement === app)
      ) {
        composer.input.focus({ preventScroll: true });
      }
    });
  }
}

function submitConversation(): void {
  const target = conversationComposerTarget;
  const state = conversationScreenState;
  const sessionId = conversationSessionId;
  const threadId = conversationThreadId;
  if (
    !target ||
    !state ||
    !sessionId ||
    !threadId ||
    state.execution.kind !== 'idle' ||
    pendingConversationSend
  ) {
    return;
  }
  const text = target.input.value;
  if (!isValidComposerText(text)) {
    return;
  }

  const requestId = createConversationRequestId();
  pendingConversationSend = { requestId, text };
  clearConversationOperationError();
  updateConversationComposer();
  vscode.postMessage({
    type: 'threads/conversation/send',
    sessionId,
    threadId,
    requestId,
    text
  });
}

function stopConversation(): void {
  const state = conversationScreenState;
  const sessionId = conversationSessionId;
  const threadId = conversationThreadId;
  if (
    !state ||
    !sessionId ||
    !threadId ||
    state.execution.kind !== 'running' ||
    pendingConversationStopRequestId
  ) {
    return;
  }

  const requestId = createConversationRequestId();
  pendingConversationStopRequestId = requestId;
  clearConversationOperationError();
  updateConversationComposer();
  vscode.postMessage({
    type: 'threads/conversation/stop',
    sessionId,
    threadId,
    requestId
  });
}

function handleConversationOperationResult(message: ConversationOperationResult): void {
  if (!isActiveConversation(message.sessionId, message.threadId)) {
    return;
  }
  const target = conversationComposerTarget;
  if (!target) {
    return;
  }

  if (message.operation === 'send') {
    const pending = pendingConversationSend;
    if (!pending || pending.requestId !== message.requestId) {
      return;
    }
    pendingConversationSend = undefined;
    if (message.outcome === 'accepted') {
      if (target.input.value === pending.text) {
        target.input.value = '';
      }
      clearConversationOperationError();
    } else {
      showConversationOperationError(message.message);
      requestAnimationFrame(() => target.input.focus());
    }
  } else {
    if (pendingConversationStopRequestId !== message.requestId) {
      return;
    }
    pendingConversationStopRequestId = undefined;
    if (message.outcome === 'accepted') {
      clearConversationOperationError();
    } else {
      showConversationOperationError(message.message);
      requestAnimationFrame(() => {
        if (!target.stop.hidden) {
          target.stop.focus();
        }
      });
    }
  }
  updateConversationComposer();
}

function updateConversationComposer(): void {
  const target = conversationComposerTarget;
  if (!target) {
    return;
  }
  const execution = conversationScreenState?.execution;
  const hasState = Boolean(conversationScreenState && conversationSessionId);
  const unavailable = execution?.kind === 'unavailable';
  const waitingForInput = Boolean(conversationScreenState?.interactions.length);
  renderRuntimeSettings(target);
  target.input.disabled = !hasState || unavailable || waitingForInput;
  target.input.readOnly = Boolean(pendingConversationSend);
  const canSend = Boolean(
    execution?.kind === 'idle' && !waitingForInput &&
    !pendingConversationSend &&
    isValidComposerText(target.input.value)
  );
  target.send.disabled = !hasState || unavailable;
  target.send.setAttribute('aria-disabled', String(!canSend));
  target.send.classList.toggle('is-disabled', !canSend);

  const stopVisible = (
    execution?.kind === 'running' ||
    execution?.kind === 'stopping' ||
    Boolean(pendingConversationStopRequestId)
  );
  const moveFocusFromStop = !stopVisible &&
    !target.stop.hidden &&
    document.activeElement === target.stop;
  target.stop.hidden = !stopVisible;
  const canStop = execution?.kind === 'running' &&
    !pendingConversationSend &&
    !pendingConversationStopRequestId;
  target.stop.disabled = false;
  target.stop.setAttribute('aria-disabled', String(!canStop));
  target.stop.classList.toggle('is-disabled', !canStop);
  target.stop.textContent = execution?.kind === 'stopping' || pendingConversationStopRequestId
    ? 'Stopping…'
    : 'Stop';
  target.container.setAttribute(
    'aria-busy',
    String(Boolean(pendingConversationSend || pendingConversationStopRequestId))
  );

  const status = waitingForInput ? 'Respond to the request above to continue.' : conversationStatus(execution);
  if (target.status.textContent !== status) {
    target.status.textContent = status;
  }
  if (moveFocusFromStop) {
    requestAnimationFrame(() => focusAfterConversationStop(target));
  }
}

function renderConversationInteractions(
  container: HTMLElement,
  interactions: readonly ConversationInteractionViewModel[]
): void {
  const cards = interactions.map((interaction) => {
    const form = document.createElement('form');
    form.className = `conversation-interaction conversation-interaction--${interaction.kind}`;
    form.dataset.interactionId = interaction.id;
    form.setAttribute('aria-labelledby', `interaction-title-${interaction.id}`);
    const title = document.createElement('h2');
    title.id = `interaction-title-${interaction.id}`;
    title.textContent = interaction.title;
    const summary = document.createElement('p');
    summary.textContent = interaction.summary;
    form.append(title, summary);

    if (isApprovalInteraction(interaction)) {
      const details = document.createElement('ul');
      for (const line of interaction.detail) {
        const item = document.createElement('li');
        item.textContent = line;
        details.append(item);
      }
      if (interaction.detail.length) form.append(details);
      form.append(interactionControls(interaction.allowSession, true));
    } else if (interaction.kind === 'userInput') {
      for (const question of interaction.questions) form.append(questionField(interaction.id, question));
      form.append(interactionControls(false, false));
    } else {
      for (const field of interaction.fields) form.append(mcpField(field));
      if (!interaction.acceptsInput) {
        const unsupported = document.createElement('p');
        unsupported.className = 'muted';
        unsupported.textContent = 'This request format cannot be completed here. You can decline or cancel it.';
        form.append(unsupported);
      }
      form.append(interactionControls(false, false, interaction.acceptsInput));
    }
    return form;
  });
  container.replaceChildren(...cards);
  container.hidden = cards.length === 0;
}

function interactionControls(allowSession: boolean, approval: boolean, allowAccept = true): HTMLElement {
  const controls = document.createElement('div');
  controls.className = 'conversation-interaction-controls';
  const decline = actionButton('Decline', 'interaction-decline');
  const cancel = actionButton('Cancel turn', 'interaction-cancel');
  controls.append(decline, cancel);
  if (allowAccept) controls.append(actionButton(approval ? 'Approve once' : 'Submit', 'interaction-accept'));
  if (approval && allowSession) controls.append(actionButton('Approve for session', 'interaction-session'));
  return controls;
}

function questionField(interactionId: string, question: Extract<ConversationInteractionViewModel, { kind: 'userInput' }>['questions'][number]): HTMLElement {
  const fieldset = document.createElement('fieldset');
  fieldset.dataset.questionId = question.id;
  const legend = document.createElement('legend');
  legend.textContent = question.header ? `${question.header}: ${question.question}` : question.question;
  fieldset.append(legend);
  if (question.options.length) {
    for (const [index, option] of question.options.entries()) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `question-${interactionId}-${question.id}`;
      input.value = option.label;
      input.required = question.required && index === 0;
      const text = document.createElement('span');
      text.textContent = option.description ? `${option.label} — ${option.description}` : option.label;
      label.append(input, text);
      fieldset.append(label);
    }
  }
  if (!question.options.length || question.allowOther) {
    const input = document.createElement('input');
    input.className = 'interaction-answer';
    input.type = question.secret ? 'password' : 'text';
    input.maxLength = 10_000;
    input.placeholder = question.options.length ? 'Other answer' : 'Your answer';
    if (!question.options.length) input.required = question.required;
    fieldset.append(input);
  }
  return fieldset;
}

function mcpField(field: Extract<ConversationInteractionViewModel, { kind: 'mcpElicitation' }>['fields'][number]): HTMLElement {
  const label = document.createElement('label');
  label.className = 'conversation-interaction-field';
  label.dataset.fieldId = field.id;
  const text = document.createElement('span');
  text.textContent = field.label;
  let input: HTMLInputElement | HTMLSelectElement;
  if (field.options.length) {
    const select = document.createElement('select');
    select.append(new Option('Select…', ''), ...field.options.map((option) => new Option(option, option)));
    input = select;
  } else {
    const element = document.createElement('input');
    element.type = field.secret ? 'password' : field.type === 'number' ? 'number' : field.type === 'boolean' ? 'checkbox' : 'text';
    input = element;
  }
  input.required = field.required;
  input.setAttribute('aria-description', field.description);
  label.append(text, input);
  return label;
}

function submitInteraction(element: HTMLElement, action: string): void {
  const form = element.closest<HTMLFormElement>('.conversation-interaction');
  const state = conversationScreenState;
  const sessionId = conversationSessionId;
  const threadId = conversationThreadId;
  const interactionId = form?.dataset.interactionId;
  if (!form || !state || !sessionId || !threadId || !interactionId) return;
  const interaction = state.interactions.find((candidate) => candidate.id === interactionId);
  if (!interaction) return;

  let reply: unknown;
  if (isApprovalInteraction(interaction)) {
    reply = { kind: 'approval', decision: action === 'session' ? 'acceptForSession' : action === 'accept' ? 'accept' : action === 'decline' ? 'decline' : 'cancel' };
  } else if (interaction.kind === 'userInput') {
    if (action === 'decline' || action === 'cancel') {
      const fallback: Record<string, string[]> = {};
      for (const question of interaction.questions) fallback[question.id] = [action === 'decline' ? 'Declined' : 'Cancelled'];
      reply = { kind: 'userInput', answers: fallback };
    } else {
      if (!form.reportValidity()) return;
      const answers: Record<string, string[]> = {};
      for (const question of interaction.questions) {
        const fieldset = [...form.querySelectorAll<HTMLElement>('fieldset')].find((item) => item.dataset.questionId === question.id);
        const selected = fieldset?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value;
        const other = fieldset?.querySelector<HTMLInputElement>('.interaction-answer')?.value.trim();
        const value = other || selected;
        if (!value) return;
        answers[question.id] = [value];
      }
      reply = { kind: 'userInput', answers };
    }
  } else {
    if (action !== 'accept') {
      reply = { kind: 'mcp', action: action === 'decline' ? 'decline' : 'cancel', values: {} };
    } else {
      if (!form.reportValidity()) return;
      const values: Record<string, unknown> = {};
      for (const field of interaction.fields) {
        const input = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field-id="${CSS.escape(field.id)}"] input, [data-field-id="${CSS.escape(field.id)}"] select`);
        if (!input) continue;
        if (input instanceof HTMLInputElement && input.type === 'checkbox') values[field.id] = input.checked;
        else if (field.type === 'number' && input.value) values[field.id] = Number(input.value);
        else values[field.id] = input.value;
      }
      reply = { kind: 'mcp', action: 'accept', values };
    }
  }
  for (const button of form.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  vscode.postMessage({ type: 'threads/conversation/interaction', sessionId, threadId, interactionId, reply });
}

function isApprovalInteraction(
  interaction: ConversationInteractionViewModel
): interaction is Extract<ConversationInteractionViewModel, { kind: 'commandApproval' | 'fileApproval' | 'permissionsApproval' }> {
  return interaction.kind === 'commandApproval' || interaction.kind === 'fileApproval' || interaction.kind === 'permissionsApproval';
}

function renderRuntimeSettings(target: ConversationComposerTarget): void {
  const runtime = conversationScreenState?.runtime;
  const ready = runtime?.status === 'ready';
  target.settings.classList.toggle('is-unavailable', !ready);
  const summaryText = runtimeSettingsSummary(runtime);
  target.runtimeSummary.textContent = summaryText;
  target.runtimeSummary.title = summaryText;
  target.runtimeSummary.setAttribute('aria-label', `Current runtime: ${summaryText}`);
  target.settingsSummary.setAttribute('aria-label', `Runtime settings: ${summaryText}`);
  syncSelect(target.model, runtime?.models ?? [], runtime?.model, false);
  syncSelect(
    target.effort,
    runtime?.efforts ?? [],
    runtime?.effort,
    true,
    defaultRuntimeLabel('Default', runtime?.defaultEffort, runtime?.efforts ?? [])
  );
  syncSelect(
    target.serviceTier,
    runtime?.serviceTiers ?? [],
    runtime?.serviceTier,
    true,
    defaultRuntimeLabel('Default speed', runtime?.defaultServiceTier, runtime?.serviceTiers ?? [])
  );
  syncSelect(target.sandbox, [
    { value: 'read-only', label: 'Read only', description: 'No workspace writes' },
    { value: 'workspace-write', label: 'Workspace', description: 'Write inside the workspace' },
    { value: 'danger-full-access', label: 'Full access', description: 'Unrestricted filesystem access' }
  ], runtime?.sandbox ?? 'workspace-write', false);
  const approvalOptions = [
    { value: 'untrusted', label: 'Strict', description: 'Ask for untrusted operations' },
    { value: 'on-request', label: 'On request', description: 'Codex may request approval' },
    { value: 'never', label: 'Never ask', description: 'Never request approval' }
  ];
  if (runtime?.approvalPolicy === 'custom') {
    approvalOptions.unshift({ value: 'custom', label: 'Custom (current)', description: 'Granular policy from Codex' });
  }
  syncSelect(target.approvalPolicy, approvalOptions, runtime?.approvalPolicy ?? 'on-request', false);
  for (const select of [target.model, target.effort, target.serviceTier, target.sandbox, target.approvalPolicy]) {
    select.disabled = !ready;
  }
  target.settings.title = runtime?.message ?? 'Changes apply to the next turn.';
}

function submitRuntimeSettings(modelChanged: boolean): void {
  const target = conversationComposerTarget;
  const state = conversationScreenState;
  const sessionId = conversationSessionId;
  const threadId = conversationThreadId;
  if (!target || !state || !sessionId || !threadId || state.runtime.status !== 'ready') return;
  if (!isRuntimeApprovalPolicy(target.approvalPolicy.value) || !isSandboxMode(target.sandbox.value)) {
    renderRuntimeSettings(target);
    return;
  }
  vscode.postMessage({
    type: 'threads/conversation/settings',
    sessionId,
    threadId,
    settings: {
      model: target.model.value,
      effort: modelChanged ? null : target.effort.value || null,
      serviceTier: modelChanged ? null : target.serviceTier.value || null,
      sandbox: target.sandbox.value,
      approvalPolicy: target.approvalPolicy.value
    }
  });
}

function toggleAddMenu(): void {
  const target = conversationComposerTarget;
  if (!target) return;
  target.addMenu.hidden = !target.addMenu.hidden;
  target.add.setAttribute('aria-expanded', String(!target.addMenu.hidden));
  if (!target.addMenu.hidden) target.settings.open = false;
}

function closeRuntimeSettings(restoreFocus: boolean): void {
  const target = conversationComposerTarget;
  if (!target) return;
  target.settings.open = false;
  if (restoreFocus) target.settingsSummary.focus({ preventScroll: true });
}

function runtimeSelect(label: string, id: string): { container: HTMLElement; select: HTMLSelectElement } {
  const container = document.createElement('label');
  container.className = 'conversation-runtime-field';
  const caption = document.createElement('span');
  caption.textContent = label;
  const select = document.createElement('select');
  select.id = id;
  select.setAttribute('aria-label', label);
  container.append(caption, select);
  return { container, select };
}

function syncSelect(
  select: HTMLSelectElement,
  options: readonly { readonly value: string; readonly label: string; readonly description: string }[],
  value: string | null | undefined,
  includeEmpty: boolean,
  emptyLabel = 'Default'
): void {
  const signature = JSON.stringify([includeEmpty, emptyLabel, options]);
  if (select.dataset.options !== signature) {
    const elements: HTMLOptionElement[] = [];
    if (includeEmpty) elements.push(new Option(emptyLabel, ''));
    for (const option of options) {
      const element = new Option(option.label, option.value);
      element.title = option.description;
      elements.push(element);
    }
    select.replaceChildren(...elements);
    select.dataset.options = signature;
  }
  select.value = value ?? '';
}

function isSandboxMode(value: string): value is 'read-only' | 'workspace-write' | 'danger-full-access' {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

function isRuntimeApprovalPolicy(value: string): value is 'untrusted' | 'on-request' | 'never' | 'custom' {
  return value === 'untrusted' || value === 'on-request' || value === 'never' || value === 'custom';
}

function announceCompletedConversationTurn(
  model: ConversationViewModel,
  initialRender: boolean
): void {
  const completed = [...model.turns]
    .reverse()
    .find((turn) => turn.status !== 'In progress');
  if (!completed) {
    return;
  }
  if (initialRender) {
    lastAnnouncedCompletedTurnId = completed.id;
    return;
  }
  if (completed.id === lastAnnouncedCompletedTurnId) {
    return;
  }
  lastAnnouncedCompletedTurnId = completed.id;
  const response = [...completed.items]
    .reverse()
    .find((item) => item.kind === 'message' && item.role === 'assistant');
  const suffix = response?.kind === 'message' && response.text.trim()
    ? ` ${response.text.trim().slice(0, 500)}`
    : '';
  const announcer = conversationComposerTarget?.announcer;
  if (announcer) {
    announcer.textContent = `Codex response complete.${suffix}`;
  }
}

function focusAfterConversationStop(target: ConversationComposerTarget): void {
  if (
    conversationComposerTarget !== target ||
    (document.activeElement !== document.body && document.activeElement !== target.stop)
  ) {
    return;
  }
  if (!target.input.disabled) {
    target.input.focus();
    return;
  }
  app.querySelector<HTMLButtonElement>('[data-action="reload"]')?.focus();
  if (document.activeElement === document.body) {
    app.querySelector<HTMLButtonElement>('[data-action="back"]')?.focus();
  }
}

function conversationStatus(execution: ConversationExecutionViewModel | undefined): string {
  if (pendingConversationStopRequestId) {
    return 'Stopping the active turn…';
  }
  if (pendingConversationSend) {
    return 'Sending message…';
  }
  switch (execution?.kind) {
    case 'idle':
      return '';
    case 'resuming':
      return 'Resuming conversation…';
    case 'starting':
      return 'Starting a new turn…';
    case 'running':
      return 'Codex is responding…';
    case 'stopping':
      return 'Stopping the active turn…';
    case 'unavailable':
      return execution.message;
    default:
      return 'Loading conversation…';
  }
}

function showConversationOperationError(message: string): void {
  const error = conversationComposerTarget?.error;
  if (!error) {
    return;
  }
  error.textContent = message;
  error.hidden = false;
}

function clearConversationOperationError(): void {
  const error = conversationComposerTarget?.error;
  if (!error) {
    return;
  }
  error.textContent = '';
  error.hidden = true;
}

function isActiveConversation(sessionId: string, threadId: string): boolean {
  return (
    screen === 'conversation' &&
    conversationSessionId === sessionId &&
    conversationThreadId === threadId
  );
}

function isNearConversationBottom(): boolean {
  return document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) <= 64;
}

function isValidComposerText(value: string): boolean {
  return Boolean(value.trim()) && value.length <= MAX_COMPOSER_TEXT_LENGTH;
}

function createConversationRequestId(): string {
  return crypto.randomUUID();
}

function focusConversationBackButton(): void {
  requestAnimationFrame(() => {
    app.querySelector<HTMLButtonElement>('[data-action="back"]')?.focus({ preventScroll: true });
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
  action: ThreadListAction | 'new' | 'open' | 'back' | 'reload' | 'send' | 'stop' | 'add' |
    'interaction-accept' | 'interaction-session' | 'interaction-decline' | 'interaction-cancel',
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
