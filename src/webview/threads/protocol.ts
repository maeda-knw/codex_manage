import type { ThreadRepositorySnapshot } from '../../codex/threadRepository';
import type { ConnectionStatus } from '../../views/threadTreeProvider';

export type ThreadsWebviewToHostMessage =
  | { readonly type: 'threads/ready' }
  | { readonly type: 'threads/command'; readonly command: 'refresh' | 'settings' | 'open' | 'loadMoreActive' | 'loadMoreArchive' | 'pin' | 'unpin' | 'rename' | 'archive' | 'unarchive'; readonly threadId?: string };

export type ThreadsHostToWebviewMessage = {
  readonly type: 'threads/state';
  readonly snapshot: ThreadRepositorySnapshot;
  readonly status: ConnectionStatus;
  readonly hasWorkspace: boolean;
};

export function isThreadsWebviewMessage(value: unknown): value is ThreadsWebviewToHostMessage {
  if (!isObject(value)) return false;
  if (value.type === 'threads/ready') return true;
  const commands = ['refresh', 'settings', 'open', 'loadMoreActive', 'loadMoreArchive', 'pin', 'unpin', 'rename', 'archive', 'unarchive'];
  return value.type === 'threads/command' && typeof value.command === 'string' && commands.includes(value.command) &&
    (value.threadId === undefined || typeof value.threadId === 'string');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
