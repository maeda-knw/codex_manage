import './styles.css';
import {
  isConversationHostMessage,
  type ConversationHostToWebviewMessage,
  type ConversationWebviewState
} from './protocol';
import type {
  ConversationItemViewModel,
  ConversationTurnViewModel,
  ConversationViewModel
} from '../../conversation/conversationViewModel';

interface VsCodeApi<T> {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
}

declare function acquireVsCodeApi<T>(): VsCodeApi<T>;

const vscode = acquireVsCodeApi<ConversationWebviewState>();
const threadTitle = requiredElement<HTMLHeadingElement>('thread-title');
const threadMeta = requiredElement<HTMLParagraphElement>('thread-meta');
const notice = requiredElement<HTMLDivElement>('notice');
const conversation = requiredElement<HTMLElement>('conversation');
const reloadButton = requiredElement<HTMLButtonElement>('reload-button');

const initialState = readInitialState();
vscode.setState(initialState);

reloadButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'conversation/reload' });
});

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isConversationHostMessage(event.data)) {
    return;
  }
  renderMessage(event.data);
});

vscode.postMessage({ type: 'conversation/ready' });

function renderMessage(message: ConversationHostToWebviewMessage): void {
  switch (message.type) {
    case 'conversation/loading':
      conversation.setAttribute('aria-busy', 'true');
      notice.hidden = false;
      notice.className = 'notice';
      notice.textContent = 'Loading conversation history…';
      return;
    case 'conversation/error':
      conversation.setAttribute('aria-busy', 'false');
      notice.hidden = false;
      notice.className = 'notice notice-error';
      notice.textContent = message.message;
      return;
    case 'conversation/loaded':
      renderConversation(message.model);
  }
}

function renderConversation(model: ConversationViewModel): void {
  threadTitle.textContent = model.title;
  threadMeta.textContent = `${model.cwd} · ${model.status} · Updated ${formatDate(model.updatedAt)}`;
  vscode.setState({ version: 1, threadId: model.threadId, title: model.title });
  conversation.replaceChildren();
  conversation.setAttribute('aria-busy', 'false');

  if (model.isPartialHistory) {
    notice.hidden = false;
    notice.className = 'notice';
    notice.textContent = 'Some historical work items are available only as a summary.';
  } else {
    notice.hidden = true;
    notice.textContent = '';
  }

  if (model.turns.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'This thread has no stored turns.';
    conversation.append(empty);
    return;
  }

  model.turns.forEach((turn, index) => {
    conversation.append(renderTurn(turn, index));
  });
}

function renderTurn(turn: ConversationTurnViewModel, index: number): HTMLElement {
  const section = document.createElement('section');
  section.className = 'turn';
  section.setAttribute('aria-labelledby', `turn-heading-${turn.id}`);

  const header = document.createElement('header');
  header.className = 'turn-header';
  const heading = document.createElement('h2');
  heading.id = `turn-heading-${turn.id}`;
  heading.textContent = `Turn ${index + 1}`;
  const status = document.createElement('span');
  status.className = `status status-${statusClass(turn.status)}`;
  status.textContent = turn.status;
  header.append(heading, status);

  const metadata = document.createElement('p');
  metadata.className = 'turn-meta muted';
  metadata.textContent = turnMetadata(turn);
  section.append(header, metadata);

  if (turn.errorMessage) {
    const error = document.createElement('p');
    error.className = 'turn-error';
    error.textContent = turn.errorMessage;
    section.append(error);
  }

  const items = document.createElement('div');
  items.className = 'turn-items';
  if (turn.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = turn.itemsView === 'full'
      ? 'No stored items for this turn.'
      : 'Detailed items were not stored for this turn.';
    items.append(empty);
  } else {
    turn.items.forEach((item) => items.append(renderItem(item)));
  }
  section.append(items);
  return section;
}

function renderItem(item: ConversationItemViewModel): HTMLElement {
  if (item.kind === 'message') {
    const article = document.createElement('article');
    article.className = `message message-${item.role}`;
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = item.role === 'user' ? 'You' : 'Codex';
    const text = document.createElement('pre');
    text.className = 'message-text';
    text.textContent = item.text;
    article.append(label, text);
    return article;
  }

  const card = document.createElement(item.detail ? 'details' : 'article');
  card.className = 'activity-card';
  const summary = document.createElement(item.detail ? 'summary' : 'div');
  summary.className = 'activity-summary';
  const title = document.createElement('span');
  title.className = 'activity-title';
  title.textContent = item.title;
  summary.append(title);
  if (item.status) {
    const status = document.createElement('span');
    status.className = `status status-${statusClass(item.status)}`;
    status.textContent = item.status;
    summary.append(status);
  }
  card.append(summary);
  if (item.detail) {
    const detail = document.createElement('pre');
    detail.className = 'activity-detail';
    detail.textContent = item.detail;
    card.append(detail);
  }
  return card;
}

function turnMetadata(turn: ConversationTurnViewModel): string {
  const values: string[] = [];
  if (turn.startedAt !== null) {
    values.push(formatDate(turn.startedAt));
  }
  if (turn.durationMs !== null) {
    values.push(`${turn.durationMs.toLocaleString()} ms`);
  }
  if (turn.itemsView !== 'full') {
    values.push(`${turn.itemsView} history`);
  }
  return values.join(' · ') || 'Stored turn';
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

function statusClass(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, '-');
}

function readInitialState(): ConversationWebviewState {
  const threadId = document.body.dataset.threadId ?? '';
  const title = document.body.dataset.threadTitle ?? 'Codex thread';
  return { version: 1, threadId, title };
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}
