import type { ConversationViewModel } from '../../conversation/conversationViewModel';

export interface ConversationWebviewState {
  readonly version: 1;
  readonly threadId: string;
  readonly title: string;
}

export type ConversationWebviewToHostMessage =
  | { readonly type: 'conversation/ready' }
  | { readonly type: 'conversation/reload' };

export type ConversationHostToWebviewMessage =
  | { readonly type: 'conversation/loading' }
  | { readonly type: 'conversation/loaded'; readonly model: ConversationViewModel }
  | { readonly type: 'conversation/error'; readonly message: string };

export function isConversationWebviewState(value: unknown): value is ConversationWebviewState {
  return (
    isObject(value) &&
    value.version === 1 &&
    typeof value.threadId === 'string' &&
    Boolean(value.threadId) &&
    typeof value.title === 'string'
  );
}

export function isConversationWebviewMessage(value: unknown): value is ConversationWebviewToHostMessage {
  return (
    isObject(value) &&
    (value.type === 'conversation/ready' || value.type === 'conversation/reload')
  );
}

export function isConversationHostMessage(value: unknown): value is ConversationHostToWebviewMessage {
  if (!isObject(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'conversation/loading') {
    return true;
  }
  if (value.type === 'conversation/error') {
    return typeof value.message === 'string';
  }
  return value.type === 'conversation/loaded' && isObject(value.model);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
