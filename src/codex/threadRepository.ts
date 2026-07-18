import * as vscode from 'vscode';
import type { AppServerClient } from './appServerClient';
import type { Thread } from './protocol/generated/v2/Thread';
import type { ThreadListParams } from './protocol/generated/v2/ThreadListParams';
import type { ThreadStatus } from './protocol/generated/v2/ThreadStatus';
import { isJsonObject, isThread } from './protocol/guards';

export type ThreadGroupKind = 'pinned' | 'recent' | 'archive';

export interface ThreadDisplayModel {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tooltip: vscode.MarkdownString;
  readonly cwd: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly recencyAt: Date;
  readonly statusLabel: string;
  readonly iconId: string;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly sourceLabel: string;
}

export interface ThreadPageState {
  readonly threads: readonly ThreadDisplayModel[];
  readonly nextCursor: string | null;
  readonly loaded: boolean;
}

export interface ThreadRepositorySnapshot {
  readonly pinned: ThreadPageState;
  readonly active: ThreadPageState;
  readonly archive: ThreadPageState;
}


export class ThreadRepository {
  private activeThreads: ThreadDisplayModel[] = [];
  private archivedThreads: ThreadDisplayModel[] = [];
  private activeCursor: string | null = null;
  private archiveCursor: string | null = null;
  private archiveLoaded = false;
  private pinnedThreadIds: readonly string[] = [];
  private readonly pendingThreadIds = new Set<string>();

  public constructor(private readonly client: AppServerClient) {}

  public setPinnedThreadIds(threadIds: readonly string[]): void {
    this.pinnedThreadIds = [...threadIds];
    this.activeThreads = applyPinState(this.activeThreads, this.pinnedThreadIds, false);
    this.archivedThreads = applyPinState(this.archivedThreads, [], true);
  }

  public snapshot(): ThreadRepositorySnapshot {
    const pinnedThreads = getPinnedThreads(this.activeThreads, this.pinnedThreadIds);
    const pinnedIds = new Set(pinnedThreads.map((thread) => thread.id));
    return {
      pinned: { threads: pinnedThreads, nextCursor: null, loaded: true },
      active: { threads: this.activeThreads.filter((thread) => !pinnedIds.has(thread.id)), nextCursor: this.activeCursor, loaded: true },
      archive: { threads: this.archivedThreads, nextCursor: this.archiveCursor, loaded: this.archiveLoaded }
    };
  }

  public isOperationPending(threadId: string): boolean {
    return this.pendingThreadIds.has(threadId);
  }

  public findThread(threadId: string): ThreadDisplayModel | undefined {
    return this.activeThreads.find((thread) => thread.id === threadId) ??
      this.archivedThreads.find((thread) => thread.id === threadId);
  }

  public reset(): void {
    this.activeThreads = [];
    this.archivedThreads = [];
    this.activeCursor = null;
    this.archiveCursor = null;
    this.archiveLoaded = false;
  }

  public async refreshActive(workspaceFolders: readonly vscode.WorkspaceFolder[], pageSize: number): Promise<ThreadPageState> {
    const page = await this.list(workspaceFolders, pageSize, false, null);
    this.activeThreads = applyPinState(page.data.map((thread) => toDisplayModel(thread, false)), this.pinnedThreadIds, false);
    this.activeCursor = page.nextCursor;
    return this.snapshot().active;
  }

  public async loadMoreActive(workspaceFolders: readonly vscode.WorkspaceFolder[], pageSize: number): Promise<ThreadPageState> {
    if (!this.activeCursor) {
      return this.snapshot().active;
    }
    const page = await this.list(workspaceFolders, pageSize, false, this.activeCursor);
    this.activeThreads = applyPinState([...this.activeThreads, ...page.data.map((thread) => toDisplayModel(thread, false))], this.pinnedThreadIds, false);
    this.activeCursor = page.nextCursor;
    return this.snapshot().active;
  }

  public async refreshArchive(workspaceFolders: readonly vscode.WorkspaceFolder[], pageSize: number): Promise<ThreadPageState> {
    const page = await this.list(workspaceFolders, pageSize, true, null);
    this.archivedThreads = applyPinState(page.data.map((thread) => toDisplayModel(thread, true)), [], true);
    this.archiveCursor = page.nextCursor;
    this.archiveLoaded = true;
    return this.snapshot().archive;
  }

  public async loadMoreArchive(workspaceFolders: readonly vscode.WorkspaceFolder[], pageSize: number): Promise<ThreadPageState> {
    if (!this.archiveCursor) {
      return this.snapshot().archive;
    }
    const page = await this.list(workspaceFolders, pageSize, true, this.archiveCursor);
    this.archivedThreads = applyPinState([...this.archivedThreads, ...page.data.map((thread) => toDisplayModel(thread, true))], [], true);
    this.archiveCursor = page.nextCursor;
    this.archiveLoaded = true;
    return this.snapshot().archive;
  }

  public async renameThread(threadId: string, name: string): Promise<void> {
    await this.runThreadOperation(threadId, async () => {
      await this.client.renameThread({ threadId, name });
      this.activeThreads = this.activeThreads.map((thread) => thread.id === threadId ? updateThreadTitle(thread, name) : thread);
      this.archivedThreads = this.archivedThreads.map((thread) => thread.id === threadId ? updateThreadTitle(thread, name) : thread);
    });
  }

  public async archiveThread(threadId: string): Promise<void> {
    await this.runThreadOperation(threadId, async () => {
      await this.client.archiveThread({ threadId });
      const thread = this.activeThreads.find((candidate) => candidate.id === threadId);
      this.activeThreads = this.activeThreads.filter((candidate) => candidate.id !== threadId);
      if (thread && this.archiveLoaded && !this.archivedThreads.some((candidate) => candidate.id === threadId)) {
        this.archivedThreads = [markArchived(thread), ...this.archivedThreads];
      }
    });
  }

  public async unarchiveThread(threadId: string): Promise<void> {
    await this.runThreadOperation(threadId, async () => {
      await this.client.unarchiveThread({ threadId });
      const thread = this.archivedThreads.find((candidate) => candidate.id === threadId);
      this.archivedThreads = this.archivedThreads.filter((candidate) => candidate.id !== threadId);
      if (thread && !this.activeThreads.some((candidate) => candidate.id === threadId)) {
        this.activeThreads = applyPinState([markActive(thread), ...this.activeThreads], this.pinnedThreadIds, false);
      }
    });
  }

  public upsertThread(thread: Thread): void {
    const display = toDisplayModel(thread, false);
    this.archivedThreads = this.archivedThreads.filter((candidate) => candidate.id !== thread.id);
    this.activeThreads = applyPinState([
      display,
      ...this.activeThreads.filter((candidate) => candidate.id !== thread.id)
    ], this.pinnedThreadIds, false);
  }

  public handleThreadNotification(method: string, params: unknown): boolean {
    if (method === 'thread/started' && isJsonObject(params) && isThread(params.thread)) {
      this.upsertThread(params.thread);
      return true;
    }
    if (!isThreadIdParams(params)) {
      return false;
    }
    if (method === 'thread/archived') {
      const before = this.activeThreads.length + this.archivedThreads.length;
      const thread = this.activeThreads.find((candidate) => candidate.id === params.threadId);
      this.activeThreads = this.activeThreads.filter((candidate) => candidate.id !== params.threadId);
      if (thread && this.archiveLoaded && !this.archivedThreads.some((candidate) => candidate.id === params.threadId)) {
        this.archivedThreads = [markArchived(thread), ...this.archivedThreads];
      }
      return before !== this.activeThreads.length + this.archivedThreads.length || Boolean(thread);
    }
    if (method === 'thread/unarchived') {
      const thread = this.archivedThreads.find((candidate) => candidate.id === params.threadId);
      this.archivedThreads = this.archivedThreads.filter((candidate) => candidate.id !== params.threadId);
      if (thread && !this.activeThreads.some((candidate) => candidate.id === params.threadId)) {
        this.activeThreads = applyPinState([markActive(thread), ...this.activeThreads], this.pinnedThreadIds, false);
      }
      return Boolean(thread);
    }
    if (method === 'thread/name/updated' && isThreadNameUpdatedParams(params)) {
      const changed = this.hasThread(params.threadId);
      this.activeThreads = this.activeThreads.map((thread) => thread.id === params.threadId ? updateThreadTitle(thread, params.threadName) : thread);
      this.archivedThreads = this.archivedThreads.map((thread) => thread.id === params.threadId ? updateThreadTitle(thread, params.threadName) : thread);
      return changed;
    }
    if (method === 'thread/status/changed' && isThreadStatusChangedParams(params)) {
      const changed = this.hasThread(params.threadId);
      this.activeThreads = this.activeThreads.map((thread) => thread.id === params.threadId ? updateThreadStatus(thread, params.status) : thread);
      return changed;
    }
    return false;
  }

  private async runThreadOperation(threadId: string, operation: () => Promise<void>): Promise<void> {
    if (this.pendingThreadIds.has(threadId)) {
      throw new Error('An operation is already running for this thread.');
    }
    this.pendingThreadIds.add(threadId);
    try {
      await operation();
    } finally {
      this.pendingThreadIds.delete(threadId);
    }
  }

  private list(workspaceFolders: readonly vscode.WorkspaceFolder[], pageSize: number, archived: boolean, cursor: string | null) {
    const params: ThreadListParams = {
      limit: pageSize,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived,
      cursor,
      cwd: workspaceFolders.map((folder) => folder.uri.fsPath)
    };
    return this.client.listThreads(params);
  }

  private hasThread(threadId: string): boolean {
    return this.activeThreads.some((thread) => thread.id === threadId) ||
      this.archivedThreads.some((thread) => thread.id === threadId);
  }
}

function updateThreadTitle(thread: ThreadDisplayModel, title: string): ThreadDisplayModel {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(title)}**\n\n`);
  tooltip.appendMarkdown(`- Workspace: \`${escapeMarkdown(thread.cwd)}\`\n`);
  tooltip.appendMarkdown(`- Created: ${thread.createdAt.toLocaleString()}\n`);
  tooltip.appendMarkdown(`- Updated: ${thread.updatedAt.toLocaleString()}\n`);
  tooltip.appendMarkdown(`- Source: ${escapeMarkdown(thread.sourceLabel)}\n`);
  tooltip.appendMarkdown(`- Thread ID: \`${escapeMarkdown(thread.id)}\``);
  return { ...thread, title, tooltip };
}

function updateThreadStatus(thread: ThreadDisplayModel, status: ThreadStatus): ThreadDisplayModel {
  const statusLabel = formatStatus(status);
  return {
    ...thread,
    description: `${formatRelativeTime(thread.recencyAt)} • ${statusLabel}`,
    statusLabel,
    iconId: thread.pinned ? 'pinned' : iconForStatus(status)
  };
}

function markArchived(thread: ThreadDisplayModel): ThreadDisplayModel {
  return { ...thread, archived: true, pinned: false, iconId: 'archive' };
}

function markActive(thread: ThreadDisplayModel): ThreadDisplayModel {
  return { ...thread, archived: false, iconId: thread.pinned ? 'pinned' : 'comment-discussion' };
}

function isThreadIdParams(value: unknown): value is { threadId: string } {
  return typeof value === 'object' && value !== null && 'threadId' in value && typeof (value as { threadId?: unknown }).threadId === 'string';
}

function isThreadNameUpdatedParams(value: unknown): value is { threadId: string; threadName: string } {
  return isThreadIdParams(value) &&
    'threadName' in value &&
    typeof (value as { threadName?: unknown }).threadName === 'string';
}

function isThreadStatusChangedParams(value: unknown): value is { threadId: string; status: ThreadStatus } {
  return isThreadIdParams(value) &&
    'status' in value &&
    isThreadStatus((value as { status?: unknown }).status);
}

function isThreadStatus(value: unknown): value is ThreadStatus {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  if (type === 'active') {
    return 'activeFlags' in value && Array.isArray((value as { activeFlags?: unknown }).activeFlags);
  }
  return type === 'idle' || type === 'notLoaded' || type === 'systemError';
}

function toDisplayModel(thread: Thread, archived: boolean): ThreadDisplayModel {
  const title = firstNonEmpty(thread.name, firstLine(thread.preview), 'Untitled thread');
  const updatedAt = fromUnixSeconds(thread.updatedAt);
  const createdAt = fromUnixSeconds(thread.createdAt);
  const recencyAt = fromUnixSeconds(thread.recencyAt ?? thread.updatedAt);
  const statusLabel = formatStatus(thread.status);
  const sourceLabel = formatSource(thread.source);
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown(`**${escapeMarkdown(title)}**\n\n`);
  tooltip.appendMarkdown(`- Workspace: \`${escapeMarkdown(thread.cwd)}\`\n`);
  tooltip.appendMarkdown(`- Created: ${createdAt.toLocaleString()}\n`);
  tooltip.appendMarkdown(`- Updated: ${updatedAt.toLocaleString()}\n`);
  tooltip.appendMarkdown(`- Source: ${escapeMarkdown(sourceLabel)}\n`);
  tooltip.appendMarkdown(`- Thread ID: \`${escapeMarkdown(thread.id)}\``);

  return {
    id: thread.id,
    title,
    description: `${formatRelativeTime(recencyAt)} • ${statusLabel}`,
    tooltip,
    cwd: thread.cwd,
    createdAt,
    updatedAt,
    recencyAt,
    statusLabel,
    iconId: archived ? 'archive' : iconForStatus(thread.status),
    archived,
    pinned: false,
    sourceLabel
  };
}

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string {
  return values.find((value) => value?.trim())?.trim() ?? 'Untitled thread';
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u, 1)[0] ?? '';
}

function fromUnixSeconds(value: number): Date {
  return new Date(value * 1_000);
}

function formatStatus(status: ThreadStatus): string {
  switch (status.type) {
    case 'active':
      return 'Running';
    case 'idle':
      return 'Idle';
    case 'systemError':
      return 'Error';
    case 'notLoaded':
      return 'Not loaded';
  }
}

function iconForStatus(status: ThreadStatus): string {
  switch (status.type) {
    case 'active':
      return 'sync~spin';
    case 'systemError':
      return 'error';
    default:
      return 'comment-discussion';
  }
}

function formatSource(source: Thread['source']): string {
  return typeof source === 'string' ? source : JSON.stringify(source);
}

function formatRelativeTime(date: Date): string {
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60]
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(deltaSeconds, 'second');
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|]/gu, '\\$&');
}


function applyPinState(
  threads: readonly ThreadDisplayModel[],
  pinnedThreadIds: readonly string[],
  archived: boolean
): ThreadDisplayModel[] {
  const pinned = new Set(archived ? [] : pinnedThreadIds);
  return threads.map((thread) => ({
    ...thread,
    pinned: pinned.has(thread.id),
    iconId: pinned.has(thread.id) ? 'pinned' : thread.iconId
  }));
}

function getPinnedThreads(
  threads: readonly ThreadDisplayModel[],
  pinnedThreadIds: readonly string[]
): ThreadDisplayModel[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return pinnedThreadIds.flatMap((threadId) => {
    const thread = byId.get(threadId);
    return thread ? [thread] : [];
  });
}
