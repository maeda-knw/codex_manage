import type { InitializeResponse } from './generated/InitializeResponse';
import type { Thread } from './generated/v2/Thread';
import type { ThreadListResponse } from './generated/v2/ThreadListResponse';

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
    Array.isArray(value.turns)
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
