import * as vscode from 'vscode';
import type { AppServerClient } from './appServerClient';
import type { Thread } from './protocol/generated/v2/Thread';
import type { ThreadListParams } from './protocol/generated/v2/ThreadListParams';

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
  readonly active: ThreadPageState;
  readonly archive: ThreadPageState;
}


export class ThreadRepository {
  private activeThreads: ThreadDisplayModel[] = [];
  private archivedThreads: ThreadDisplayModel[] = [];
  private activeCursor: string | null = null;
  private archiveCursor: string | null = null;
  private archiveLoaded = false;

  public constructor(private readonly client: AppServerClient) {}

  public snapshot(): ThreadRepositorySnapshot {
    return {
      active: { threads: this.activeThreads, nextCursor: this.activeCursor, loaded: true },
      archive: { threads: this.archivedThreads, nextCursor: this.archiveCursor, loaded: this.archiveLoaded }
    };
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
    this.activeThreads = page.data.map((thread) => toDisplayModel(thread, false));
    this.activeCursor = page.nextCursor;
    return this.snapshot().active;
  }

  public async loadMoreActive(workspaceFolders: readonly vscode.WorkspaceFolder[], pageSize: number): Promise<ThreadPageState> {
    if (!this.activeCursor) {
      return this.snapshot().active;
    }
    const page = await this.list(workspaceFolders, pageSize, false, this.activeCursor);
    this.activeThreads = [...this.activeThreads, ...page.data.map((thread) => toDisplayModel(thread, false))];
    this.activeCursor = page.nextCursor;
    return this.snapshot().active;
  }

  public async refreshArchive(workspaceFolders: readonly vscode.WorkspaceFolder[], pageSize: number): Promise<ThreadPageState> {
    const page = await this.list(workspaceFolders, pageSize, true, null);
    this.archivedThreads = page.data.map((thread) => toDisplayModel(thread, true));
    this.archiveCursor = page.nextCursor;
    this.archiveLoaded = true;
    return this.snapshot().archive;
  }

  public async loadMoreArchive(workspaceFolders: readonly vscode.WorkspaceFolder[], pageSize: number): Promise<ThreadPageState> {
    if (!this.archiveCursor) {
      return this.snapshot().archive;
    }
    const page = await this.list(workspaceFolders, pageSize, true, this.archiveCursor);
    this.archivedThreads = [...this.archivedThreads, ...page.data.map((thread) => toDisplayModel(thread, true))];
    this.archiveCursor = page.nextCursor;
    this.archiveLoaded = true;
    return this.snapshot().archive;
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

function formatStatus(status: Thread['status']): string {
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

function iconForStatus(status: Thread['status']): string {
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
