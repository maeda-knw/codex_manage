import type {
  ConversationItemViewModel,
  ConversationTurnViewModel,
  ConversationViewModel
} from '../../conversation/conversationViewModel';
import type {
  ConversationRuntimeSettings,
  ConversationRuntimeSettingsUpdate
} from '../../conversation/conversationSession';

export const MAX_COMPOSER_TEXT_LENGTH = 100_000;
export const MAX_CONVERSATION_ID_LENGTH = 512;

export type ThreadListAction =
  | 'loadMoreActive'
  | 'loadMoreArchive'
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'archive'
  | 'unarchive';

export interface ThreadListItemViewModel {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly statusLabel: string;
  readonly pinned: boolean;
  readonly archived: boolean;
}

export interface ThreadListPageViewModel {
  readonly threads: readonly ThreadListItemViewModel[];
  readonly nextCursor: string | null;
  readonly loaded: boolean;
}

export interface ThreadListSnapshotViewModel {
  readonly pinned: ThreadListPageViewModel;
  readonly active: ThreadListPageViewModel;
  readonly archive: ThreadListPageViewModel;
}

export type ThreadListGroupId = 'pinned' | 'active' | 'archive';

export interface ThreadListExpandedGroups {
  readonly pinned: boolean;
  readonly active: boolean;
  readonly archive: boolean;
}

export type ThreadListConnectionStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly message: string };

export type ConversationExecutionViewModel =
  | { readonly kind: 'idle' }
  | { readonly kind: 'resuming' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'running'; readonly turnId: string }
  | { readonly kind: 'stopping'; readonly turnId: string }
  | { readonly kind: 'unavailable'; readonly message: string };

export interface ConversationScreenState {
  readonly sessionId: string;
  readonly revision: number;
  readonly model: ConversationViewModel;
  readonly execution: ConversationExecutionViewModel;
  readonly runtime: ConversationRuntimeSettings;
  readonly notice?: string;
}

export type ConversationOperation = 'send' | 'stop';

export type ConversationOperationResult =
  | {
    readonly type: 'threads/conversationOperationResult';
    readonly sessionId: string;
    readonly threadId: string;
    readonly requestId: string;
    readonly operation: ConversationOperation;
    readonly outcome: 'accepted';
  }
  | {
    readonly type: 'threads/conversationOperationResult';
    readonly sessionId: string;
    readonly threadId: string;
    readonly requestId: string;
    readonly operation: ConversationOperation;
    readonly outcome: 'rejected';
    readonly message: string;
  };

export type ThreadsWebviewToHostMessage =
  | { readonly type: 'threads/ready' }
  | { readonly type: 'threads/open'; readonly threadId: string }
  | { readonly type: 'threads/back' }
  | { readonly type: 'threads/reload' }
  | {
    readonly type: 'threads/conversation/send';
    readonly sessionId: string;
    readonly threadId: string;
    readonly requestId: string;
    readonly text: string;
  }
  | {
    readonly type: 'threads/conversation/stop';
    readonly sessionId: string;
    readonly threadId: string;
    readonly requestId: string;
  }
  | {
    readonly type: 'threads/conversation/settings';
    readonly sessionId: string;
    readonly threadId: string;
    readonly settings: ConversationRuntimeSettingsUpdate;
  }
  | {
    readonly type: 'threads/action';
    readonly action: ThreadListAction;
    readonly threadId?: string;
  };

export type ThreadsHostToWebviewMessage =
  | {
    readonly type: 'threads/listState';
    readonly snapshot: ThreadListSnapshotViewModel;
    readonly status: ThreadListConnectionStatus;
    readonly hasWorkspace: boolean;
  }
  | { readonly type: 'threads/showList' }
  | {
    readonly type: 'threads/conversationLoading';
    readonly sessionId: string;
    readonly threadId: string;
    readonly title: string;
  }
  | {
    readonly type: 'threads/conversationLoaded';
    readonly state: ConversationScreenState;
  }
  | {
    readonly type: 'threads/conversationState';
    readonly state: ConversationScreenState;
  }
  | {
    readonly type: 'threads/conversationError';
    readonly sessionId: string;
    readonly threadId: string;
    readonly title: string;
    readonly message: string;
  }
  | ConversationOperationResult;

export interface ThreadsWebviewState {
  readonly version: 2;
  readonly screen: 'list' | 'conversation';
  readonly selectedThreadId: string | null;
  readonly listScrollTop: number;
  readonly expandedGroups: ThreadListExpandedGroups;
}

interface LegacyThreadsWebviewState {
  readonly version: 1;
  readonly screen: 'list' | 'conversation';
  readonly selectedThreadId: string | null;
  readonly listScrollTop: number;
}

const ACTIONS: readonly ThreadListAction[] = [
  'loadMoreActive',
  'loadMoreArchive',
  'pin',
  'unpin',
  'rename',
  'archive',
  'unarchive'
];

const THREAD_SCOPED_ACTIONS: readonly ThreadListAction[] = [
  'pin',
  'unpin',
  'rename',
  'archive',
  'unarchive'
];

export function isThreadsWebviewMessage(value: unknown): value is ThreadsWebviewToHostMessage {
  if (!isObject(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'threads/ready' || value.type === 'threads/back' || value.type === 'threads/reload') {
    return true;
  }
  if (value.type === 'threads/open') {
    return isBoundedId(value.threadId);
  }
  if (value.type === 'threads/conversation/send') {
    return (
      hasOnlyKeys(value, ['type', 'sessionId', 'threadId', 'requestId', 'text']) &&
      isBoundedId(value.sessionId) &&
      isBoundedId(value.threadId) &&
      isBoundedId(value.requestId) &&
      typeof value.text === 'string' &&
      Boolean(value.text.trim()) &&
      value.text.length <= MAX_COMPOSER_TEXT_LENGTH
    );
  }
  if (value.type === 'threads/conversation/stop') {
    return (
      hasOnlyKeys(value, ['type', 'sessionId', 'threadId', 'requestId']) &&
      isBoundedId(value.sessionId) &&
      isBoundedId(value.threadId) &&
      isBoundedId(value.requestId)
    );
  }
  if (value.type === 'threads/conversation/settings') {
    return (
      hasOnlyKeys(value, ['type', 'sessionId', 'threadId', 'settings']) &&
      isBoundedId(value.sessionId) &&
      isBoundedId(value.threadId) &&
      isRuntimeSettingsUpdate(value.settings)
    );
  }
  if (
    value.type !== 'threads/action' ||
    typeof value.action !== 'string' ||
    !ACTIONS.includes(value.action as ThreadListAction)
  ) {
    return false;
  }
  const action = value.action as ThreadListAction;
  return THREAD_SCOPED_ACTIONS.includes(action)
    ? isNonEmptyString(value.threadId)
    : value.threadId === undefined;
}

export function isThreadsHostMessage(value: unknown): value is ThreadsHostToWebviewMessage {
  if (!isObject(value) || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'threads/showList':
      return true;
    case 'threads/listState':
      return isObject(value.snapshot) && isObject(value.status) && typeof value.hasWorkspace === 'boolean';
    case 'threads/conversationLoading':
      return isBoundedId(value.sessionId) && isBoundedId(value.threadId) && typeof value.title === 'string';
    case 'threads/conversationLoaded':
    case 'threads/conversationState':
      return isConversationScreenState(value.state);
    case 'threads/conversationError':
      return (
        isBoundedId(value.sessionId) &&
        isBoundedId(value.threadId) &&
        typeof value.title === 'string' &&
        typeof value.message === 'string'
      );
    case 'threads/conversationOperationResult':
      return isConversationOperationResult(value);
    default:
      return false;
  }
}

export function isConversationScreenState(value: unknown): value is ConversationScreenState {
  return (
    isObject(value) &&
    isBoundedId(value.sessionId) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    isConversationViewModel(value.model) &&
    isConversationExecution(value.execution) &&
    isRuntimeSettings(value.runtime) &&
    (value.notice === undefined || typeof value.notice === 'string')
  );
}

function isRuntimeSettings(value: unknown): value is ConversationRuntimeSettings {
  return (
    isObject(value) &&
    (value.status === 'loading' || value.status === 'ready' || value.status === 'unavailable') &&
    Array.isArray(value.models) && value.models.every(isRuntimeOption) &&
    (value.model === null || typeof value.model === 'string') &&
    Array.isArray(value.efforts) && value.efforts.every(isRuntimeOption) &&
    (value.effort === null || typeof value.effort === 'string') &&
    Array.isArray(value.serviceTiers) && value.serviceTiers.every(isRuntimeOption) &&
    (value.serviceTier === null || typeof value.serviceTier === 'string') &&
    isSandboxMode(value.sandbox) &&
    (value.approvalPolicy === 'untrusted' || value.approvalPolicy === 'on-request' || value.approvalPolicy === 'never' || value.approvalPolicy === 'custom') &&
    (value.message === null || typeof value.message === 'string')
  );
}

function isRuntimeOption(value: unknown): boolean {
  return isObject(value) && typeof value.value === 'string' && typeof value.label === 'string' && typeof value.description === 'string';
}

function isRuntimeSettingsUpdate(value: unknown): value is ConversationRuntimeSettingsUpdate {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ['model', 'effort', 'serviceTier', 'sandbox', 'approvalPolicy']) &&
    typeof value.model === 'string' && Boolean(value.model) &&
    (value.effort === null || typeof value.effort === 'string') &&
    (value.serviceTier === null || typeof value.serviceTier === 'string') &&
    isSandboxMode(value.sandbox) &&
    (value.approvalPolicy === 'untrusted' || value.approvalPolicy === 'on-request' || value.approvalPolicy === 'never')
  );
}

function isSandboxMode(value: unknown): boolean {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

export function isThreadsWebviewState(value: unknown): value is ThreadsWebviewState {
  return (
    isObject(value) &&
    value.version === 2 &&
    hasValidNavigationState(value) &&
    isObject(value.expandedGroups) &&
    typeof value.expandedGroups.pinned === 'boolean' &&
    typeof value.expandedGroups.active === 'boolean' &&
    typeof value.expandedGroups.archive === 'boolean'
  );
}

export function restoreThreadsWebviewState(value: unknown): ThreadsWebviewState {
  if (isThreadsWebviewState(value)) {
    return {
      version: 2,
      screen: value.screen,
      selectedThreadId: value.selectedThreadId,
      listScrollTop: value.listScrollTop,
      expandedGroups: {
        pinned: value.expandedGroups.pinned,
        active: value.expandedGroups.active,
        archive: value.expandedGroups.archive
      }
    };
  }
  if (isLegacyThreadsWebviewState(value)) {
    return {
      version: 2,
      screen: value.screen,
      selectedThreadId: value.selectedThreadId,
      listScrollTop: value.listScrollTop,
      expandedGroups: defaultExpandedGroups()
    };
  }
  return {
    version: 2,
    screen: 'list',
    selectedThreadId: null,
    listScrollTop: 0,
    expandedGroups: defaultExpandedGroups()
  };
}

function isLegacyThreadsWebviewState(value: unknown): value is LegacyThreadsWebviewState {
  return isObject(value) && value.version === 1 && hasValidNavigationState(value);
}

function hasValidNavigationState(value: Record<string, unknown>): boolean {
  return (
    (value.screen === 'list' || value.screen === 'conversation') &&
    (value.selectedThreadId === null || isNonEmptyString(value.selectedThreadId)) &&
    typeof value.listScrollTop === 'number' &&
    Number.isFinite(value.listScrollTop) &&
    value.listScrollTop >= 0 &&
    (value.screen !== 'conversation' || isNonEmptyString(value.selectedThreadId))
  );
}

function defaultExpandedGroups(): ThreadListExpandedGroups {
  return { pinned: true, active: true, archive: false };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isBoundedId(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= MAX_CONVERSATION_ID_LENGTH;
}

function isConversationOperationResult(
  value: Record<string, unknown>
): value is ConversationOperationResult {
  if (
    !isBoundedId(value.sessionId) ||
    !isBoundedId(value.threadId) ||
    !isBoundedId(value.requestId) ||
    (value.operation !== 'send' && value.operation !== 'stop')
  ) {
    return false;
  }
  return value.outcome === 'accepted' || (
    value.outcome === 'rejected' && typeof value.message === 'string'
  );
}

function isConversationExecution(value: unknown): value is ConversationExecutionViewModel {
  if (!isObject(value) || typeof value.kind !== 'string') {
    return false;
  }
  switch (value.kind) {
    case 'idle':
    case 'resuming':
    case 'starting':
      return true;
    case 'running':
    case 'stopping':
      return isBoundedId(value.turnId);
    case 'unavailable':
      return typeof value.message === 'string';
    default:
      return false;
  }
}

function isConversationViewModel(value: unknown): value is ConversationViewModel {
  return (
    isObject(value) &&
    isBoundedId(value.threadId) &&
    typeof value.title === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.status === 'string' &&
    isFiniteNumber(value.updatedAt) &&
    typeof value.isPartialHistory === 'boolean' &&
    Array.isArray(value.turns) &&
    value.turns.every(isConversationTurn)
  );
}

function isConversationTurn(value: unknown): value is ConversationTurnViewModel {
  return (
    isObject(value) &&
    isBoundedId(value.id) &&
    typeof value.status === 'string' &&
    (value.itemsView === 'notLoaded' || value.itemsView === 'summary' || value.itemsView === 'full') &&
    isNullableFiniteNumber(value.startedAt) &&
    isNullableFiniteNumber(value.completedAt) &&
    isNullableFiniteNumber(value.durationMs) &&
    (value.errorMessage === null || typeof value.errorMessage === 'string') &&
    Array.isArray(value.items) &&
    value.items.every(isConversationItem)
  );
}

function isConversationItem(value: unknown): value is ConversationItemViewModel {
  if (!isObject(value) || !isBoundedId(value.id)) {
    return false;
  }
  if (value.kind === 'message') {
    return (
      (value.role === 'user' || value.role === 'assistant') &&
      typeof value.text === 'string'
    );
  }
  return (
    value.kind === 'activity' &&
    typeof value.activityKind === 'string' &&
    typeof value.title === 'string' &&
    (value.status === null || typeof value.status === 'string') &&
    (value.detail === null || typeof value.detail === 'string')
  );
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
