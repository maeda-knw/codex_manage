import type {
  ConversationItemViewModel,
  ConversationTurnViewModel,
  ConversationViewModel
} from '../../conversation/conversationViewModel';

export interface ConversationRenderTarget {
  readonly title: HTMLElement;
  readonly meta: HTMLElement;
  readonly notice: HTMLElement;
  readonly content: HTMLElement;
}

export function renderConversationLoading(
  target: ConversationRenderTarget,
  title?: string
): void {
  if (title) {
    target.title.textContent = title;
  }
  target.meta.textContent = 'Loading conversation history…';
  target.content.replaceChildren();
  target.content.setAttribute('aria-busy', 'true');
  target.notice.hidden = false;
  target.notice.className = 'notice';
  target.notice.textContent = 'Loading conversation history…';
}

export function renderConversationError(
  target: ConversationRenderTarget,
  message: string,
  title?: string
): void {
  if (title) {
    target.title.textContent = title;
  }
  target.meta.textContent = 'Conversation history could not be loaded.';
  target.content.replaceChildren();
  target.content.setAttribute('aria-busy', 'false');
  target.notice.hidden = false;
  target.notice.className = 'notice notice-error';
  target.notice.textContent = message;
}

export function renderConversation(
  target: ConversationRenderTarget,
  model: ConversationViewModel
): void {
  target.title.textContent = model.title;
  target.meta.textContent = `${model.cwd} · ${model.status} · Updated ${formatDate(model.updatedAt)}`;
  target.content.replaceChildren();
  target.content.setAttribute('aria-busy', 'false');

  if (model.isPartialHistory) {
    target.notice.hidden = false;
    target.notice.className = 'notice';
    target.notice.textContent = 'Some historical work items are available only as a summary.';
  } else {
    target.notice.hidden = true;
    target.notice.textContent = '';
  }

  if (model.turns.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'This thread has no stored turns.';
    target.content.append(empty);
    return;
  }

  model.turns.forEach((turn, index) => {
    target.content.append(renderTurn(turn, index));
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
