import type { Thread } from '../codex/protocol/generated/v2/Thread';
import type { ThreadItem } from '../codex/protocol/generated/v2/ThreadItem';
import type { Turn } from '../codex/protocol/generated/v2/Turn';
import type { UserInput } from '../codex/protocol/generated/v2/UserInput';

const MAX_DETAIL_LENGTH = 20_000;

export interface ConversationViewModel {
  readonly threadId: string;
  readonly title: string;
  readonly cwd: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly isPartialHistory: boolean;
  readonly turns: readonly ConversationTurnViewModel[];
}

export interface ConversationTurnViewModel {
  readonly id: string;
  readonly status: string;
  readonly itemsView: Turn['itemsView'];
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
  readonly errorMessage: string | null;
  readonly items: readonly ConversationItemViewModel[];
}

export type ConversationItemViewModel =
  | {
    readonly kind: 'message';
    readonly id: string;
    readonly role: 'user' | 'assistant';
    readonly text: string;
  }
  | {
    readonly kind: 'activity';
    readonly id: string;
    readonly activityKind: string;
    readonly title: string;
    readonly status: string | null;
    readonly detail: string | null;
  };

export function toConversationViewModel(thread: Thread): ConversationViewModel {
  return {
    threadId: thread.id,
    title: firstNonEmpty(thread.name, firstLine(thread.preview), 'Untitled thread'),
    cwd: thread.cwd,
    status: formatThreadStatus(thread.status.type),
    updatedAt: thread.updatedAt * 1_000,
    isPartialHistory: thread.turns.some((turn) => turn.itemsView !== 'full'),
    turns: thread.turns.map(toTurnViewModel)
  };
}

function toTurnViewModel(turn: Turn): ConversationTurnViewModel {
  return {
    id: turn.id,
    status: formatTurnStatus(turn.status),
    itemsView: turn.itemsView,
    startedAt: toMilliseconds(turn.startedAt),
    completedAt: toMilliseconds(turn.completedAt),
    durationMs: turn.durationMs,
    errorMessage: turn.error?.message ?? null,
    items: turn.items.map(toItemViewModel)
  };
}

function toItemViewModel(item: ThreadItem): ConversationItemViewModel {
  switch (item.type) {
    case 'userMessage':
      return {
        kind: 'message',
        id: item.id,
        role: 'user',
        text: formatUserInputs(item.content)
      };
    case 'agentMessage':
      return {
        kind: 'message',
        id: item.id,
        role: 'assistant',
        text: item.text || 'No response text.'
      };
    case 'plan':
      return activity(item.id, 'plan', 'Plan', null, item.text);
    case 'reasoning':
      return activity(
        item.id,
        'reasoning',
        'Reasoning summary',
        null,
        item.summary.join('\n\n') || null
      );
    case 'commandExecution':
      return activity(
        item.id,
        'command',
        item.command,
        formatStatus(item.status),
        joinDetails(
          `Working directory: ${item.cwd}`,
          item.exitCode === null ? null : `Exit code: ${item.exitCode}`,
          formatDuration(item.durationMs)
        )
      );
    case 'fileChange':
      return activity(
        item.id,
        'fileChange',
        `File changes (${item.changes.length})`,
        formatStatus(item.status),
        item.changes
          .map((change) => {
            const move = change.kind.type === 'update' && change.kind.move_path
              ? ` -> ${change.kind.move_path}`
              : '';
            return `${change.kind.type}: ${change.path}${move}`;
          })
          .join('\n')
      );
    case 'mcpToolCall':
      return activity(
        item.id,
        'mcp',
        `${item.server}: ${item.tool}`,
        formatStatus(item.status),
        joinDetails(item.error?.message ?? null, formatDuration(item.durationMs))
      );
    case 'dynamicToolCall':
      return activity(
        item.id,
        'tool',
        item.namespace ? `${item.namespace}: ${item.tool}` : item.tool,
        formatStatus(item.status),
        formatDuration(item.durationMs)
      );
    case 'collabAgentToolCall':
      return activity(
        item.id,
        'collaboration',
        `Agent collaboration: ${String(item.tool)}`,
        formatStatus(item.status),
        null
      );
    case 'subAgentActivity':
      return activity(
        item.id,
        'subAgent',
        `Sub-agent activity: ${String(item.kind)}`,
        null,
        `Agent thread: ${item.agentThreadId}`
      );
    case 'webSearch':
      return activity(item.id, 'webSearch', 'Web search', null, item.query);
    case 'hookPrompt':
      return activity(
        item.id,
        'hook',
        'Hook prompt',
        null,
        null
      );
    case 'imageView':
      return activity(item.id, 'image', 'Viewed image', null, null);
    case 'imageGeneration':
      return activity(
        item.id,
        'imageGeneration',
        'Image generation',
        formatStatus(item.status),
        null
      );
    case 'sleep':
      return activity(item.id, 'sleep', 'Wait', 'completed', formatDuration(item.durationMs));
    case 'enteredReviewMode':
      return activity(item.id, 'review', 'Entered review mode', null, null);
    case 'exitedReviewMode':
      return activity(item.id, 'review', 'Exited review mode', null, null);
    case 'contextCompaction':
      return activity(item.id, 'context', 'Context compacted', null, null);
    default: {
      const unknownItem = item as { readonly id?: unknown; readonly type?: unknown };
      return activity(
        typeof unknownItem.id === 'string' ? unknownItem.id : 'unknown-item',
        'unknown',
        `Unsupported work item: ${
          typeof unknownItem.type === 'string' ? unknownItem.type : 'unknown'
        }`,
        null,
        null
      );
    }
  }
}

function formatUserInputs(inputs: readonly UserInput[]): string {
  const text = inputs.map((input) => {
    switch (input.type) {
      case 'text':
        return input.text;
      case 'image':
      case 'localImage':
        return '[Image attachment]';
      case 'skill':
        return `[Skill: ${input.name}]`;
      case 'mention':
        return `[Mention: ${input.name}]`;
    }
  }).filter(Boolean).join('\n\n');

  return text || 'Empty message.';
}

function activity(
  id: string,
  activityKind: string,
  title: string,
  status: string | null,
  detail: string | null
): ConversationItemViewModel {
  return {
    kind: 'activity',
    id,
    activityKind,
    title,
    status,
    detail: truncate(detail)
  };
}

function truncate(value: string | null): string | null {
  if (!value || value.length <= MAX_DETAIL_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_DETAIL_LENGTH)}\n\n… output truncated …`;
}

function joinDetails(...values: readonly (string | null | undefined)[]): string | null {
  const detail = values.filter((value): value is string => Boolean(value)).join('\n\n');
  return detail || null;
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) {
    return null;
  }
  return `Duration: ${durationMs.toLocaleString()} ms`;
}

function formatThreadStatus(status: Thread['status']['type']): string {
  switch (status) {
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

function formatTurnStatus(status: Turn['status']): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'interrupted':
      return 'Interrupted';
    case 'failed':
      return 'Failed';
    case 'inProgress':
      return 'In progress';
  }
}

function formatStatus(status: string): string {
  return status.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/^./u, (value) => value.toUpperCase());
}

function toMilliseconds(value: number | null): number | null {
  return value === null ? null : value * 1_000;
}

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string {
  return values.find((value) => value?.trim())?.trim() ?? 'Untitled thread';
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u, 1)[0] ?? '';
}
