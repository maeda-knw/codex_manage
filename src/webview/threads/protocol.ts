import type { ConversationViewModel } from '../../conversation/conversationViewModel';

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

export type ThreadsWebviewToHostMessage =
  | { readonly type: 'threads/ready' }
  | { readonly type: 'threads/open'; readonly threadId: string }
  | { readonly type: 'threads/back' }
  | { readonly type: 'threads/reload' }
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
    readonly threadId: string;
    readonly title: string;
  }
  | {
    readonly type: 'threads/conversationLoaded';
    readonly model: ConversationViewModel;
  }
  | {
    readonly type: 'threads/conversationError';
    readonly threadId: string;
    readonly title: string;
    readonly message: string;
  };

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
    return isNonEmptyString(value.threadId);
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
      return isNonEmptyString(value.threadId) && typeof value.title === 'string';
    case 'threads/conversationLoaded':
      return isObject(value.model);
    case 'threads/conversationError':
      return isNonEmptyString(value.threadId) && typeof value.title === 'string' && typeof value.message === 'string';
    default:
      return false;
  }
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
