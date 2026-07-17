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

let nextTurnHeadingId = 0;

export function renderConversationLoading(
  target: ConversationRenderTarget,
  title?: string,
  preserveContent = false
): void {
  if (title) {
    target.title.textContent = title;
  }
  target.meta.textContent = 'Loading conversation history…';
  if (!preserveContent) {
    target.content.replaceChildren();
  }
  target.content.setAttribute('aria-busy', 'true');
  target.notice.hidden = false;
  target.notice.className = 'notice';
  target.notice.textContent = 'Loading conversation history…';
}

export function renderConversationError(
  target: ConversationRenderTarget,
  message: string,
  title?: string,
  preserveContent = false
): void {
  if (title) {
    target.title.textContent = title;
  }
  target.meta.textContent = 'Conversation history could not be loaded.';
  if (!preserveContent) {
    target.content.replaceChildren();
  }
  target.content.setAttribute('aria-busy', 'false');
  target.notice.hidden = false;
  target.notice.className = 'notice notice-error';
  target.notice.textContent = message;
}

export function renderConversation(
  target: ConversationRenderTarget,
  model: ConversationViewModel
): void {
  setTextContent(target.title, model.title);
  setTextContent(
    target.meta,
    `${model.cwd} · ${model.status} · Updated ${formatDate(model.updatedAt)}`
  );
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
    renderEmptyConversation(target.content);
    return;
  }

  reconcileTurns(target.content, model.turns);
}

function reconcileTurns(
  content: HTMLElement,
  turns: readonly ConversationTurnViewModel[]
): void {
  const existing = keyedChildren(content, 'turnId');
  const retained = new Set<HTMLElement>();

  turns.forEach((turn, index) => {
    let section = existing.get(turn.id);
    if (!section || section.dataset.renderKind !== 'turn') {
      section = createTurn();
    }
    updateTurn(section, turn, index);
    placeChild(content, section, index);
    retained.add(section);
  });

  removeUnretainedChildren(content, retained);
}

function createTurn(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'turn';
  section.dataset.renderKind = 'turn';

  const header = document.createElement('header');
  header.className = 'turn-header';
  const heading = document.createElement('h2');
  heading.id = `conversation-turn-heading-${++nextTurnHeadingId}`;
  const status = document.createElement('span');
  status.className = 'status';
  header.append(heading, status);

  const metadata = document.createElement('p');
  metadata.className = 'turn-meta muted';

  const items = document.createElement('div');
  items.className = 'turn-items';
  section.append(header, metadata, items);
  return section;
}

function updateTurn(
  section: HTMLElement,
  turn: ConversationTurnViewModel,
  index: number
): void {
  section.dataset.turnId = turn.id;
  const heading = requiredDescendant<HTMLHeadingElement>(section, '.turn-header h2');
  setTextContent(heading, `Turn ${index + 1}`);
  section.setAttribute('aria-labelledby', heading.id);

  const status = requiredDescendant<HTMLElement>(section, '.turn-header .status');
  setClassName(status, `status status-${statusClass(turn.status)}`);
  setTextContent(status, turn.status);

  setTextContent(requiredDescendant<HTMLElement>(section, '.turn-meta'), turnMetadata(turn));
  const items = requiredDescendant<HTMLElement>(section, '.turn-items');
  updateTurnError(section, items, turn.errorMessage);
  reconcileItems(items, turn);
}

function updateTurnError(
  section: HTMLElement,
  items: HTMLElement,
  errorMessage: string | null
): void {
  const current = directChildWithClass(section, 'turn-error');
  if (!errorMessage) {
    current?.remove();
    return;
  }
  const error = current ?? document.createElement('p');
  error.className = 'turn-error';
  setTextContent(error, errorMessage);
  if (!current) {
    section.insertBefore(error, items);
  }
}

function reconcileItems(items: HTMLElement, turn: ConversationTurnViewModel): void {
  if (turn.items.length === 0) {
    const message = turn.itemsView === 'full'
      ? 'No stored items for this turn.'
      : 'Detailed items were not stored for this turn.';
    const current = items.children.length === 1
      ? items.firstElementChild
      : null;
    if (current instanceof HTMLElement && current.classList.contains('turn-items-empty')) {
      setTextContent(current, message);
    } else {
      const empty = document.createElement('p');
      empty.className = 'muted turn-items-empty';
      empty.textContent = message;
      items.replaceChildren(empty);
    }
    return;
  }

  const existing = keyedChildren(items, 'itemId');
  const retained = new Set<HTMLElement>();
  turn.items.forEach((item, index) => {
    let element = existing.get(item.id);
    if (!element || !isCompatibleItemElement(element, item)) {
      element = createItem(item);
    }
    updateItem(element, item);
    placeChild(items, element, index);
    retained.add(element);
  });
  removeUnretainedChildren(items, retained);
}

function createItem(item: ConversationItemViewModel): HTMLElement {
  if (item.kind === 'message') {
    const article = document.createElement('article');
    const label = document.createElement('div');
    label.className = 'message-label';
    const text = document.createElement('pre');
    text.className = 'message-text';
    article.append(label, text);
    return article;
  }

  const card = document.createElement(item.detail ? 'details' : 'article');
  const summary = document.createElement(item.detail ? 'summary' : 'div');
  summary.className = 'activity-summary';
  card.append(summary);
  if (item.detail) {
    const detail = document.createElement('pre');
    detail.className = 'activity-detail';
    card.append(detail);
  }
  return card;
}

function updateItem(element: HTMLElement, item: ConversationItemViewModel): void {
  element.dataset.itemId = item.id;
  element.dataset.itemKind = item.kind;
  if (item.kind === 'message') {
    element.dataset.itemRole = item.role;
    setClassName(element, `message message-${item.role}`);
    setTextContent(
      requiredDescendant<HTMLElement>(element, '.message-label'),
      item.role === 'user' ? 'You' : 'Codex'
    );
    setAppendableText(requiredDescendant<HTMLElement>(element, '.message-text'), item.text);
    return;
  }

  delete element.dataset.itemRole;
  setClassName(element, 'activity-card');
  const summary = requiredDescendant<HTMLElement>(element, '.activity-summary');
  let title = directChildWithClass(summary, 'activity-title');
  if (!title) {
    title = document.createElement('span');
    title.className = 'activity-title';
    summary.prepend(title);
  }
  setTextContent(title, item.title);
  const currentStatus = directChildWithClass(summary, 'status');
  if (item.status) {
    const status = currentStatus ?? document.createElement('span');
    setClassName(status, `status status-${statusClass(item.status)}`);
    setTextContent(status, item.status);
    if (!currentStatus) {
      summary.append(status);
    }
  } else {
    currentStatus?.remove();
  }
  const detail = directChildWithClass(element, 'activity-detail');
  if (item.detail && detail) {
    setTextContent(detail, item.detail);
  }
}

function isCompatibleItemElement(
  element: HTMLElement,
  item: ConversationItemViewModel
): boolean {
  if (element.dataset.itemKind !== item.kind) {
    return false;
  }
  if (item.kind === 'message') {
    return element.dataset.itemRole === item.role;
  }
  return (element instanceof HTMLDetailsElement) === Boolean(item.detail);
}

function renderEmptyConversation(content: HTMLElement): void {
  const current = content.children.length === 1
    ? content.firstElementChild
    : null;
  if (current instanceof HTMLElement && current.classList.contains('empty-state')) {
    setTextContent(current, 'This thread has no stored turns.');
    return;
  }
  const empty = document.createElement('p');
  empty.className = 'empty-state';
  empty.textContent = 'This thread has no stored turns.';
  content.replaceChildren(empty);
}

function setTextContent(element: HTMLElement, value: string): void {
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

function setAppendableText(element: HTMLElement, value: string): void {
  const current = element.textContent ?? '';
  if (current === value) {
    return;
  }
  const textNode = element.childNodes.length === 1 && element.firstChild instanceof Text
    ? element.firstChild
    : undefined;
  if (textNode && value.startsWith(current)) {
    textNode.appendData(value.slice(current.length));
    return;
  }
  setTextContent(element, value);
}

function setClassName(element: HTMLElement, value: string): void {
  if (element.className !== value) {
    element.className = value;
  }
}

function keyedChildren(parent: HTMLElement, key: 'turnId' | 'itemId'): Map<string, HTMLElement> {
  const result = new Map<string, HTMLElement>();
  for (const child of parent.children) {
    if (child instanceof HTMLElement) {
      const id = child.dataset[key];
      if (id && !result.has(id)) {
        result.set(id, child);
      }
    }
  }
  return result;
}

function placeChild(parent: HTMLElement, child: HTMLElement, index: number): void {
  const current = parent.children.item(index);
  if (current !== child) {
    parent.insertBefore(child, current);
  }
}

function removeUnretainedChildren(parent: HTMLElement, retained: ReadonlySet<HTMLElement>): void {
  for (const child of [...parent.children]) {
    if (child instanceof HTMLElement && !retained.has(child)) {
      child.remove();
    }
  }
}

function directChildWithClass(parent: HTMLElement, className: string): HTMLElement | undefined {
  return [...parent.children].find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains(className)
  );
}

function requiredDescendant<T extends HTMLElement>(parent: HTMLElement, selector: string): T {
  const element = parent.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing conversation element: ${selector}`);
  }
  return element;
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
