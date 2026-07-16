import type { InitializeResponse } from './generated/InitializeResponse';
import type { Thread } from './generated/v2/Thread';
import type { ThreadListResponse } from './generated/v2/ThreadListResponse';
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse';

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRequestId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

export function parseInitializeResponse(value: unknown): InitializeResponse {
  if (
    !isJsonObject(value) ||
    typeof value.userAgent !== 'string' ||
    typeof value.codexHome !== 'string' ||
    typeof value.platformFamily !== 'string' ||
    typeof value.platformOs !== 'string'
  ) {
    throw new Error('App Server returned an invalid initialize response.');
  }

  return value as InitializeResponse;
}

export function parseThreadListResponse(value: unknown): ThreadListResponse {
  if (
    !isJsonObject(value) ||
    !Array.isArray(value.data) ||
    !isNullableString(value.nextCursor) ||
    !isNullableString(value.backwardsCursor) ||
    !value.data.every(isThread)
  ) {
    throw new Error('App Server returned an invalid thread/list response.');
  }

  return value as ThreadListResponse;
}

export function parseThreadReadResponse(
  value: unknown,
  expectedThreadId?: string
): ThreadReadResponse {
  if (
    !isJsonObject(value) ||
    !isThread(value.thread) ||
    (expectedThreadId !== undefined && value.thread.id !== expectedThreadId)
  ) {
    throw new Error('App Server returned an invalid thread/read response.');
  }

  return value as ThreadReadResponse;
}

function isThread(value: unknown): value is Thread {
  if (!isJsonObject(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    isNullableString(value.forkedFromId) &&
    isNullableString(value.parentThreadId) &&
    typeof value.preview === 'string' &&
    typeof value.ephemeral === 'boolean' &&
    typeof value.modelProvider === 'string' &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    (value.recencyAt === null || isFiniteNumber(value.recencyAt)) &&
    isThreadStatus(value.status) &&
    isNullableString(value.path) &&
    typeof value.cwd === 'string' &&
    typeof value.cliVersion === 'string' &&
    (typeof value.source === 'string' || isJsonObject(value.source)) &&
    isNullableString(value.threadSource) &&
    isNullableString(value.agentNickname) &&
    isNullableString(value.agentRole) &&
    (value.gitInfo === null || isJsonObject(value.gitInfo)) &&
    isNullableString(value.name) &&
    Array.isArray(value.turns) &&
    value.turns.every(isTurn)
  );
}

function isTurn(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.items) &&
    value.items.every(isThreadItem) &&
    isOneOf(value.itemsView, ['notLoaded', 'summary', 'full']) &&
    isOneOf(value.status, ['completed', 'interrupted', 'failed', 'inProgress']) &&
    (
      value.error === null ||
      (
        isJsonObject(value.error) &&
        typeof value.error.message === 'string' &&
        (
          value.error.codexErrorInfo === null ||
          typeof value.error.codexErrorInfo === 'string' ||
          isJsonObject(value.error.codexErrorInfo)
        ) &&
        isNullableString(value.error.additionalDetails)
      )
    ) &&
    isNullableFiniteNumber(value.startedAt) &&
    isNullableFiniteNumber(value.completedAt) &&
    isNullableFiniteNumber(value.durationMs)
  );
}

function isThreadItem(value: unknown): boolean {
  if (!isJsonObject(value) || typeof value.type !== 'string' || typeof value.id !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'userMessage':
      return Array.isArray(value.content) && value.content.every(isUserInput);
    case 'agentMessage':
      return typeof value.text === 'string';
    case 'plan':
      return typeof value.text === 'string';
    case 'reasoning':
      return isStringArray(value.summary) && isStringArray(value.content);
    case 'commandExecution':
      return (
        typeof value.command === 'string' &&
        typeof value.cwd === 'string' &&
        isOneOf(value.status, ['inProgress', 'completed', 'failed', 'declined']) &&
        isNullableString(value.aggregatedOutput) &&
        isNullableFiniteNumber(value.exitCode) &&
        isNullableFiniteNumber(value.durationMs)
      );
    case 'fileChange':
      return (
        Array.isArray(value.changes) &&
        value.changes.every(isFileUpdateChange) &&
        isOneOf(value.status, ['inProgress', 'completed', 'failed', 'declined'])
      );
    case 'mcpToolCall':
      return (
        typeof value.server === 'string' &&
        typeof value.tool === 'string' &&
        isOneOf(value.status, ['inProgress', 'completed', 'failed']) &&
        (
          value.error === null ||
          (isJsonObject(value.error) && typeof value.error.message === 'string')
        ) &&
        isNullableFiniteNumber(value.durationMs)
      );
    case 'dynamicToolCall':
      return (
        typeof value.tool === 'string' &&
        isNullableString(value.namespace) &&
        isOneOf(value.status, ['inProgress', 'completed', 'failed']) &&
        isNullableFiniteNumber(value.durationMs)
      );
    case 'collabAgentToolCall':
      return (
        isOneOf(value.tool, ['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent']) &&
        isOneOf(value.status, ['inProgress', 'completed', 'failed'])
      );
    case 'subAgentActivity':
      return (
        isOneOf(value.kind, ['started', 'interacted', 'interrupted']) &&
        typeof value.agentThreadId === 'string'
      );
    case 'webSearch':
      return typeof value.query === 'string';
    case 'hookPrompt':
      return (
        Array.isArray(value.fragments) &&
        value.fragments.every((fragment) =>
          isJsonObject(fragment) &&
          typeof fragment.text === 'string' &&
          typeof fragment.hookRunId === 'string'
        )
      );
    case 'imageView':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
    case 'contextCompaction':
      return true;
    case 'sleep':
      return isFiniteNumber(value.durationMs);
    case 'imageGeneration':
      return typeof value.status === 'string';
    default:
      return true;
  }
}

function isUserInput(value: unknown): boolean {
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'text':
      return typeof value.text === 'string' && Array.isArray(value.text_elements);
    case 'image':
      return typeof value.url === 'string';
    case 'localImage':
      return typeof value.path === 'string';
    case 'skill':
    case 'mention':
      return typeof value.name === 'string' && typeof value.path === 'string';
    default:
      return false;
  }
}

function isFileUpdateChange(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    typeof value.path === 'string' &&
    typeof value.diff === 'string' &&
    isJsonObject(value.kind) &&
    isOneOf(value.kind.type, ['add', 'delete', 'update']) &&
    (value.kind.type !== 'update' || isNullableString(value.kind.move_path))
  );
}

function isThreadStatus(value: unknown): boolean {
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'active') {
    return Array.isArray(value.activeFlags);
  }

  return value.type === 'notLoaded' || value.type === 'idle' || value.type === 'systemError';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOneOf<const T extends readonly unknown[]>(value: unknown, choices: T): value is T[number] {
  return choices.includes(value);
}
