import type { InitializeResponse } from './generated/InitializeResponse';
import type { ServerNotification } from './generated/ServerNotification';
import type { Thread } from './generated/v2/Thread';
import type { ThreadListResponse } from './generated/v2/ThreadListResponse';
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse';
import type { AskForApproval } from './generated/v2/AskForApproval';
import type { ApprovalsReviewer } from './generated/v2/ApprovalsReviewer';
import type { SandboxMode } from './generated/v2/SandboxMode';
import type { ModelListResponse } from './generated/v2/ModelListResponse';
import type { SkillsListResponse } from './generated/v2/SkillsListResponse';
import type { ThreadItem } from './generated/v2/ThreadItem';
import type { ThreadStatus } from './generated/v2/ThreadStatus';
import type { Turn } from './generated/v2/Turn';
import type { TurnError } from './generated/v2/TurnError';
import type { TurnInterruptResponse } from './generated/v2/TurnInterruptResponse';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse';

type ConversationNotificationMethod =
  | 'error'
  | 'turn/started'
  | 'turn/completed'
  | 'item/started'
  | 'item/completed'
  | 'item/agentMessage/delta'
  | 'thread/status/changed';

export type ConversationNotification = Extract<
  ServerNotification,
  { method: ConversationNotificationMethod }
>;

export type JsonObject = Record<string, unknown>;

export interface ConversationConfigDefaults {
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly sandbox: SandboxMode | null;
  readonly approvalPolicy: AskForApproval | null;
  readonly approvalsReviewer: ApprovalsReviewer | null;
}

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

export function parseThreadResumeResponse(
  value: unknown,
  expectedThreadId?: string
): ThreadResumeResponse {
  if (
    !isJsonObject(value) ||
    !isThread(value.thread) ||
    (expectedThreadId !== undefined && value.thread.id !== expectedThreadId) ||
    typeof value.model !== 'string' ||
    typeof value.modelProvider !== 'string' ||
    !isNullableString(value.serviceTier) ||
    typeof value.cwd !== 'string' ||
    !isStringArray(value.instructionSources) ||
    !isAskForApproval(value.approvalPolicy) ||
    !isOneOf(value.approvalsReviewer, ['user', 'auto_review', 'guardian_subagent']) ||
    !isSandboxPolicy(value.sandbox) ||
    !isNullableString(value.reasoningEffort)
  ) {
    throw new Error('App Server returned an invalid thread/resume response.');
  }

  return value as ThreadResumeResponse;
}

export function parseThreadStartResponse(value: unknown): ThreadStartResponse {
  if (
    !isJsonObject(value) ||
    !isThread(value.thread) ||
    typeof value.model !== 'string' ||
    typeof value.modelProvider !== 'string' ||
    !isNullableString(value.serviceTier) ||
    typeof value.cwd !== 'string' ||
    !isStringArray(value.instructionSources) ||
    !isAskForApproval(value.approvalPolicy) ||
    !isOneOf(value.approvalsReviewer, ['user', 'auto_review', 'guardian_subagent']) ||
    !isSandboxPolicy(value.sandbox) ||
    !isNullableString(value.reasoningEffort)
  ) {
    throw new Error('App Server returned an invalid thread/start response.');
  }

  return value as ThreadStartResponse;
}

export function parseConversationConfigDefaults(value: unknown): ConversationConfigDefaults {
  if (!isJsonObject(value) || !isJsonObject(value.config)) {
    throw new Error('App Server returned an invalid config/read response.');
  }
  const config = value.config;
  if (
    !isNullableString(config.model) ||
    !isNullableString(config.model_reasoning_effort) ||
    !isNullableString(config.service_tier) ||
    !(config.sandbox_mode === null || isOneOf(config.sandbox_mode, ['read-only', 'workspace-write', 'danger-full-access'])) ||
    !(config.approval_policy === null || isAskForApproval(config.approval_policy)) ||
    !(config.approvals_reviewer === null || isOneOf(config.approvals_reviewer, ['user', 'auto_review', 'guardian_subagent']))
  ) {
    throw new Error('App Server returned an invalid config/read response.');
  }
  return {
    model: config.model,
    reasoningEffort: config.model_reasoning_effort,
    serviceTier: config.service_tier,
    sandbox: config.sandbox_mode,
    approvalPolicy: config.approval_policy as AskForApproval | null,
    approvalsReviewer: config.approvals_reviewer as ApprovalsReviewer | null
  };
}

export function parseTurnStartResponse(value: unknown): TurnStartResponse {
  if (!isJsonObject(value) || !isTurn(value.turn)) {
    throw new Error('App Server returned an invalid turn/start response.');
  }

  return value as TurnStartResponse;
}

export function parseTurnInterruptResponse(value: unknown): TurnInterruptResponse {
  if (!isJsonObject(value) || Object.keys(value).length !== 0) {
    throw new Error('App Server returned an invalid turn/interrupt response.');
  }

  return value as TurnInterruptResponse;
}

export function parseModelListResponse(value: unknown): ModelListResponse {
  if (
    !isJsonObject(value) ||
    !Array.isArray(value.data) ||
    !isNullableString(value.nextCursor) ||
    !value.data.every((model) => (
      isJsonObject(model) &&
      typeof model.id === 'string' &&
      typeof model.model === 'string' &&
      typeof model.displayName === 'string' &&
      typeof model.description === 'string' &&
      typeof model.hidden === 'boolean' &&
      typeof model.defaultReasoningEffort === 'string' &&
      Array.isArray(model.supportedReasoningEfforts) &&
      model.supportedReasoningEfforts.every((option) => (
        isJsonObject(option) &&
        typeof option.reasoningEffort === 'string' &&
        typeof option.description === 'string'
      )) &&
      Array.isArray(model.serviceTiers) &&
      model.serviceTiers.every((tier) => (
        isJsonObject(tier) &&
        typeof tier.id === 'string' &&
        typeof tier.name === 'string' &&
        typeof tier.description === 'string'
      )) &&
      isNullableString(model.defaultServiceTier) &&
      typeof model.isDefault === 'boolean'
    ))
  ) {
    throw new Error('App Server returned an invalid model/list response.');
  }
  return value as ModelListResponse;
}

export function parseSkillsListResponse(
  value: unknown,
  requestedCwds: readonly string[] = []
): SkillsListResponse {
  if (
    !isJsonObject(value) ||
    !Array.isArray(value.data) ||
    !value.data.every((entry) => (
      isJsonObject(entry) &&
      typeof entry.cwd === 'string' &&
      (requestedCwds.length === 0 || requestedCwds.includes(entry.cwd)) &&
      Array.isArray(entry.skills) &&
      entry.skills.every((skill) => (
        isJsonObject(skill) &&
        typeof skill.name === 'string' &&
        typeof skill.description === 'string' &&
        typeof skill.path === 'string' &&
        isOneOf(skill.scope, ['user', 'repo', 'system', 'admin']) &&
        typeof skill.enabled === 'boolean'
      )) &&
      Array.isArray(entry.errors)
    ))
  ) {
    throw new Error('App Server returned an invalid skills/list response.');
  }
  return value as SkillsListResponse;
}

export function parseConversationNotification(
  method: string,
  params: unknown
): ConversationNotification | undefined {
  switch (method) {
    case 'error':
      if (
        !isJsonObject(params) ||
        !isTurnError(params.error) ||
        typeof params.willRetry !== 'boolean' ||
        typeof params.threadId !== 'string' ||
        typeof params.turnId !== 'string'
      ) {
        throw invalidConversationNotification(method);
      }
      break;
    case 'turn/started':
    case 'turn/completed':
      if (
        !isJsonObject(params) ||
        typeof params.threadId !== 'string' ||
        !isTurn(params.turn)
      ) {
        throw invalidConversationNotification(method);
      }
      break;
    case 'item/started':
      if (
        !isItemLifecycleNotification(params, 'startedAtMs')
      ) {
        throw invalidConversationNotification(method);
      }
      break;
    case 'item/completed':
      if (
        !isItemLifecycleNotification(params, 'completedAtMs')
      ) {
        throw invalidConversationNotification(method);
      }
      break;
    case 'item/agentMessage/delta':
      if (
        !isJsonObject(params) ||
        typeof params.threadId !== 'string' ||
        typeof params.turnId !== 'string' ||
        typeof params.itemId !== 'string' ||
        typeof params.delta !== 'string'
      ) {
        throw invalidConversationNotification(method);
      }
      break;
    case 'thread/status/changed':
      if (
        !isJsonObject(params) ||
        typeof params.threadId !== 'string' ||
        !isThreadStatus(params.status)
      ) {
        throw invalidConversationNotification(method);
      }
      break;
    default:
      return undefined;
  }

  return { method, params } as ConversationNotification;
}

export function isThread(value: unknown): value is Thread {
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

export function isTurn(value: unknown): value is Turn {
  return (
    isJsonObject(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.items) &&
    value.items.every(isThreadItem) &&
    isOneOf(value.itemsView, ['notLoaded', 'summary', 'full']) &&
    isOneOf(value.status, ['completed', 'interrupted', 'failed', 'inProgress']) &&
    (
      value.error === null || isTurnError(value.error)
    ) &&
    isNullableFiniteNumber(value.startedAt) &&
    isNullableFiniteNumber(value.completedAt) &&
    isNullableFiniteNumber(value.durationMs)
  );
}

export function isThreadItem(value: unknown): value is ThreadItem {
  if (!isJsonObject(value) || typeof value.type !== 'string' || typeof value.id !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'userMessage':
      return (
        isNullableString(value.clientId) &&
        Array.isArray(value.content) &&
        value.content.every(isUserInput)
      );
    case 'agentMessage':
      return (
        typeof value.text === 'string' &&
        (value.phase === null || isOneOf(value.phase, ['commentary', 'final_answer'])) &&
        (value.memoryCitation === null || isMemoryCitation(value.memoryCitation))
      );
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
      return typeof value.path === 'string';
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return typeof value.review === 'string';
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
      return (
        typeof value.text === 'string' &&
        Array.isArray(value.text_elements) &&
        value.text_elements.every(isTextElement)
      );
    case 'image':
      return isOptionalImageDetail(value.detail) && typeof value.url === 'string';
    case 'localImage':
      return isOptionalImageDetail(value.detail) && typeof value.path === 'string';
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

export function isThreadStatus(value: unknown): value is ThreadStatus {
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'active') {
    return (
      Array.isArray(value.activeFlags) &&
      value.activeFlags.every((flag) => isOneOf(flag, ['waitingOnApproval', 'waitingOnUserInput']))
    );
  }

  return value.type === 'notLoaded' || value.type === 'idle' || value.type === 'systemError';
}

export function isTurnError(value: unknown): value is TurnError {
  return (
    isJsonObject(value) &&
    typeof value.message === 'string' &&
    (value.codexErrorInfo === null || isCodexErrorInfo(value.codexErrorInfo)) &&
    isNullableString(value.additionalDetails)
  );
}

function isItemLifecycleNotification(
  value: unknown,
  timestampKey: 'startedAtMs' | 'completedAtMs'
): boolean {
  return (
    isJsonObject(value) &&
    typeof value.threadId === 'string' &&
    typeof value.turnId === 'string' &&
    isThreadItem(value.item) &&
    isFiniteNumber(value[timestampKey])
  );
}

function invalidConversationNotification(method: ConversationNotificationMethod): Error {
  return new Error(`App Server returned invalid ${method} notification params.`);
}

function isAskForApproval(value: unknown): boolean {
  if (isOneOf(value, ['untrusted', 'on-request', 'never'])) {
    return true;
  }
  if (!isJsonObject(value) || !isJsonObject(value.granular)) {
    return false;
  }
  const granular = value.granular;
  return (
    typeof granular.sandbox_approval === 'boolean' &&
    typeof granular.rules === 'boolean' &&
    typeof granular.skill_approval === 'boolean' &&
    typeof granular.request_permissions === 'boolean' &&
    typeof granular.mcp_elicitations === 'boolean'
  );
}

function isSandboxPolicy(value: unknown): boolean {
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'dangerFullAccess':
      return true;
    case 'readOnly':
      return typeof value.networkAccess === 'boolean';
    case 'externalSandbox':
      return isOneOf(value.networkAccess, ['restricted', 'enabled']);
    case 'workspaceWrite':
      return (
        isStringArray(value.writableRoots) &&
        typeof value.networkAccess === 'boolean' &&
        typeof value.excludeTmpdirEnvVar === 'boolean' &&
        typeof value.excludeSlashTmp === 'boolean'
      );
    default:
      return false;
  }
}

function isTextElement(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    isJsonObject(value.byteRange) &&
    isFiniteNumber(value.byteRange.start) &&
    isFiniteNumber(value.byteRange.end) &&
    isNullableString(value.placeholder)
  );
}

function isOptionalImageDetail(value: unknown): boolean {
  return value === undefined || isOneOf(value, ['auto', 'low', 'high', 'original']);
}

function isMemoryCitation(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => (
      isJsonObject(entry) &&
      typeof entry.path === 'string' &&
      isFiniteNumber(entry.lineStart) &&
      isFiniteNumber(entry.lineEnd) &&
      typeof entry.note === 'string'
    )) &&
    isStringArray(value.threadIds)
  );
}

function isCodexErrorInfo(value: unknown): boolean {
  if (
    isOneOf(value, [
      'contextWindowExceeded',
      'sessionBudgetExceeded',
      'usageLimitExceeded',
      'serverOverloaded',
      'cyberPolicy',
      'internalServerError',
      'unauthorized',
      'badRequest',
      'threadRollbackFailed',
      'sandboxError',
      'other'
    ])
  ) {
    return true;
  }
  if (!isJsonObject(value)) {
    return false;
  }
  for (const key of [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts'
  ]) {
    if (key in value) {
      const detail = value[key];
      return isJsonObject(detail) && isNullableFiniteNumber(detail.httpStatusCode);
    }
  }
  if ('activeTurnNotSteerable' in value) {
    const detail = value.activeTurnNotSteerable;
    return isJsonObject(detail) && isOneOf(detail.turnKind, ['review', 'compact']);
  }
  return false;
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
