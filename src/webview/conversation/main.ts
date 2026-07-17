import './styles.css';
import {
  isConversationHostMessage,
  type ConversationHostToWebviewMessage,
  type ConversationWebviewState
} from './protocol';
import {
  renderConversation,
  renderConversationError,
  renderConversationLoading,
  type ConversationRenderTarget
} from './render';

interface VsCodeApi<T> {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
}

declare function acquireVsCodeApi<T>(): VsCodeApi<T>;

const vscode = acquireVsCodeApi<ConversationWebviewState>();
const target: ConversationRenderTarget = {
  title: requiredElement<HTMLHeadingElement>('thread-title'),
  meta: requiredElement<HTMLParagraphElement>('thread-meta'),
  notice: requiredElement<HTMLDivElement>('notice'),
  content: requiredElement<HTMLElement>('conversation')
};
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
      renderConversationLoading(target);
      return;
    case 'conversation/error':
      renderConversationError(target, message.message);
      return;
    case 'conversation/loaded':
      renderConversation(target, message.model);
      vscode.setState({
        version: 1,
        threadId: message.model.threadId,
        title: message.model.title
      });
  }
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
