import type { RequestId } from '../codex/protocol/generated/RequestId';
import { isJsonObject } from '../codex/protocol/guards';

export type ConversationApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ConversationInteractionOption {
  readonly label: string;
  readonly description: string;
}

export interface ConversationQuestionViewModel {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly secret: boolean;
  readonly options: readonly ConversationInteractionOption[];
  readonly allowOther: boolean;
  readonly required: boolean;
}

export interface ConversationFormFieldViewModel {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly type: 'string' | 'number' | 'boolean';
  readonly required: boolean;
  readonly secret: boolean;
  readonly options: readonly string[];
}

export type ConversationInteractionViewModel =
  | {
    readonly id: string;
    readonly kind: 'commandApproval' | 'fileApproval' | 'permissionsApproval';
    readonly title: string;
    readonly summary: string;
    readonly detail: readonly string[];
    readonly allowSession: boolean;
  }
  | {
    readonly id: string;
    readonly kind: 'userInput';
    readonly title: string;
    readonly summary: string;
    readonly questions: readonly ConversationQuestionViewModel[];
  }
  | {
    readonly id: string;
    readonly kind: 'mcpElicitation';
    readonly title: string;
    readonly summary: string;
    readonly fields: readonly ConversationFormFieldViewModel[];
    readonly acceptsInput: boolean;
  };

export interface ParsedConversationInteraction {
  readonly requestId: RequestId;
  readonly method: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly view: ConversationInteractionViewModel;
  readonly params: Record<string, unknown>;
}

export type ConversationInteractionReply =
  | { readonly kind: 'approval'; readonly decision: ConversationApprovalDecision }
  | { readonly kind: 'userInput'; readonly answers: Readonly<Record<string, readonly string[]>> }
  | { readonly kind: 'mcp'; readonly action: 'accept' | 'decline' | 'cancel'; readonly values: Readonly<Record<string, unknown>> };

export function parseConversationInteraction(
  requestId: RequestId,
  interactionId: string,
  method: string,
  value: unknown
): ParsedConversationInteraction | undefined {
  if (!isJsonObject(value) || typeof value.threadId !== 'string' || !value.threadId) return undefined;
  const turnId = typeof value.turnId === 'string' ? value.turnId : null;
  if (method === 'item/commandExecution/requestApproval') {
    if (!hasItemLifecycle(value, turnId)) return undefined;
    const detail = compact([
      typeof value.command === 'string' ? value.command : undefined,
      typeof value.cwd === 'string' ? `Working directory: ${value.cwd}` : undefined,
      networkDetail(value.networkApprovalContext)
    ]);
    return parsed(requestId, method, value.threadId, turnId, interactionId, value, {
      id: interactionId,
      kind: 'commandApproval',
      title: 'Command approval required',
      summary: optionalText(value.reason, 'Codex wants to run this command outside the current restrictions.'),
      detail,
      allowSession: Boolean(value.proposedExecpolicyAmendment) || Array.isArray(value.proposedNetworkPolicyAmendments)
    });
  }
  if (method === 'item/fileChange/requestApproval') {
    if (!hasItemLifecycle(value, turnId)) return undefined;
    return parsed(requestId, method, value.threadId, turnId, interactionId, value, {
      id: interactionId,
      kind: 'fileApproval',
      title: 'File change approval required',
      summary: optionalText(value.reason, 'Codex wants permission to change files.'),
      detail: compact([typeof value.grantRoot === 'string' ? `Requested root: ${value.grantRoot}` : undefined]),
      allowSession: typeof value.grantRoot === 'string'
    });
  }
  if (method === 'item/permissions/requestApproval' && isJsonObject(value.permissions)) {
    if (!hasItemLifecycle(value, turnId) || !sanitizeRequestedPermissions(value.permissions)) return undefined;
    return parsed(requestId, method, value.threadId, turnId, interactionId, value, {
      id: interactionId,
      kind: 'permissionsApproval',
      title: 'Additional permissions required',
      summary: optionalText(value.reason, 'Codex wants broader permissions for this work.'),
      detail: permissionDetails(value.permissions),
      allowSession: true
    });
  }
  if (method === 'item/tool/requestUserInput' && Array.isArray(value.questions)) {
    if (turnId === null || typeof value.itemId !== 'string' || !value.itemId) return undefined;
    const questions = value.questions.map(parseQuestion);
    if (questions.some((question) => !question) || questions.length === 0 || questions.length > 3) return undefined;
    return parsed(requestId, method, value.threadId, turnId, interactionId, value, {
      id: interactionId,
      kind: 'userInput',
      title: 'Codex needs your input',
      summary: 'Answer the questions below to continue the turn.',
      questions: questions as ConversationQuestionViewModel[]
    });
  }
  if (method === 'mcpServer/elicitation/request' && typeof value.serverName === 'string') {
    const mode = value.mode;
    const fields = mode === 'form' ? parseMcpFields(value.requestedSchema) : [];
    const acceptsInput = mode === 'form' && fields !== undefined;
    return parsed(requestId, method, value.threadId, turnId, interactionId, value, {
      id: interactionId,
      kind: 'mcpElicitation',
      title: `Input requested by ${value.serverName}`,
      summary: optionalText(value.message, mode === 'url' ? 'The MCP server requests an external interaction.' : 'The MCP server requests structured input.'),
      fields: fields ?? [],
      acceptsInput
    });
  }
  return undefined;
}

export function buildConversationInteractionResponse(
  interaction: ParsedConversationInteraction,
  reply: ConversationInteractionReply
): unknown | undefined {
  if (reply.kind === 'approval') {
    if (interaction.method === 'item/commandExecution/requestApproval') {
      if (reply.decision === 'acceptForSession' && !interaction.view.kind.endsWith('Approval')) return undefined;
      return { decision: reply.decision };
    }
    if (interaction.method === 'item/fileChange/requestApproval') {
      return { decision: reply.decision };
    }
    if (interaction.method === 'item/permissions/requestApproval') {
      if (reply.decision === 'decline' || reply.decision === 'cancel') {
        return { permissions: {}, scope: 'turn' };
      }
      const requested = interaction.params.permissions;
      if (!isJsonObject(requested)) return undefined;
      const permissions = sanitizeRequestedPermissions(requested);
      if (!permissions) return undefined;
      return { permissions, scope: reply.decision === 'acceptForSession' ? 'session' : 'turn' };
    }
    return undefined;
  }
  if (reply.kind === 'userInput' && interaction.method === 'item/tool/requestUserInput') {
    const questions = interaction.view.kind === 'userInput' ? interaction.view.questions : [];
    const answers: Record<string, { answers: readonly string[] }> = {};
    for (const question of questions) {
      const answer = reply.answers[question.id];
      if (!answer || answer.length === 0 || answer.some((part) => typeof part !== 'string' || part.length > 10_000)) return undefined;
      answers[question.id] = { answers: answer };
    }
    return { answers };
  }
  if (reply.kind === 'mcp' && interaction.method === 'mcpServer/elicitation/request') {
    if (reply.action !== 'accept') return { action: reply.action, content: null, _meta: null };
    if (interaction.view.kind !== 'mcpElicitation' || !interaction.view.acceptsInput) return undefined;
    const content: Record<string, unknown> = {};
    for (const field of interaction.view.fields) {
      const value = reply.values[field.id];
      if (value === undefined || value === '') {
        if (field.required) return undefined;
        continue;
      }
      if (field.type === 'string' && typeof value !== 'string') return undefined;
      if (field.type === 'number' && typeof value !== 'number') return undefined;
      if (field.type === 'boolean' && typeof value !== 'boolean') return undefined;
      if (field.options.length && !field.options.includes(String(value))) return undefined;
      content[field.id] = value;
    }
    return { action: 'accept', content, _meta: null };
  }
  return undefined;
}

function parsed(
  requestId: RequestId, method: string, threadId: string, turnId: string | null,
  interactionId: string, params: Record<string, unknown>, view: ConversationInteractionViewModel
): ParsedConversationInteraction {
  return { requestId, method, threadId, turnId, params, view: { ...view, id: interactionId } };
}

function parseQuestion(value: unknown): ConversationQuestionViewModel | undefined {
  if (!isJsonObject(value) || typeof value.id !== 'string' || !value.id || typeof value.question !== 'string' ||
    typeof value.isOther !== 'boolean' || typeof value.isSecret !== 'boolean') return undefined;
  if (value.options !== null && (!Array.isArray(value.options) || !value.options.every(isQuestionOption))) return undefined;
  const options = value.options === null ? [] : value.options.map((option) => ({ label: option.label as string, description: option.description as string }));
  return {
    id: value.id,
    header: typeof value.header === 'string' ? value.header : '',
    question: value.question,
    secret: value.isSecret === true,
    options,
    allowOther: value.isOther === true,
    required: true
  };
}

function hasItemLifecycle(value: Record<string, unknown>, turnId: string | null): boolean {
  return turnId !== null && typeof value.itemId === 'string' && Boolean(value.itemId) &&
    typeof value.startedAtMs === 'number' && Number.isFinite(value.startedAtMs);
}

function sanitizeRequestedPermissions(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  if (value.network !== null && value.network !== undefined) {
    if (!isJsonObject(value.network) || (value.network.enabled !== null && typeof value.network.enabled !== 'boolean')) return undefined;
    result.network = { enabled: value.network.enabled };
  }
  if (value.fileSystem !== null && value.fileSystem !== undefined) {
    if (!isJsonObject(value.fileSystem)) return undefined;
    const read = stringArrayOrNull(value.fileSystem.read);
    const write = stringArrayOrNull(value.fileSystem.write);
    if (read === undefined || write === undefined) return undefined;
    const fileSystem: Record<string, unknown> = { read, write };
    if (typeof value.fileSystem.globScanMaxDepth === 'number' && Number.isSafeInteger(value.fileSystem.globScanMaxDepth)) {
      fileSystem.globScanMaxDepth = value.fileSystem.globScanMaxDepth;
    }
    if (value.fileSystem.entries !== undefined) {
      if (!Array.isArray(value.fileSystem.entries) || !value.fileSystem.entries.every(isFileSystemEntry)) return undefined;
      fileSystem.entries = value.fileSystem.entries.map((entry) => ({ path: { ...(entry.path as Record<string, unknown>) }, access: entry.access }));
    }
    result.fileSystem = fileSystem;
  }
  return result;
}

function stringArrayOrNull(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : undefined;
}

function isFileSystemEntry(value: unknown): value is Record<string, unknown> & { path: Record<string, unknown> } {
  if (!isJsonObject(value) || !['read', 'write', 'deny'].includes(String(value.access)) || !isJsonObject(value.path)) return false;
  const path = value.path;
  if (path.type === 'path') return typeof path.path === 'string';
  if (path.type === 'glob_pattern') return typeof path.pattern === 'string';
  if (path.type !== 'special' || !isJsonObject(path.value)) return false;
  if (['root', 'minimal', 'tmpdir', 'slash_tmp'].includes(String(path.value.kind))) return true;
  if (path.value.kind === 'project_roots') return path.value.subpath === null || typeof path.value.subpath === 'string';
  return path.value.kind === 'unknown' && typeof path.value.path === 'string' &&
    (path.value.subpath === null || typeof path.value.subpath === 'string');
}

function isQuestionOption(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value) && typeof value.label === 'string' && typeof value.description === 'string';
}

function parseMcpFields(value: unknown): ConversationFormFieldViewModel[] | undefined {
  if (!isJsonObject(value) || value.type !== 'object' || !isJsonObject(value.properties)) return undefined;
  const required = new Set(Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === 'string') : []);
  const fields: ConversationFormFieldViewModel[] = [];
  for (const [id, schema] of Object.entries(value.properties)) {
    if (!isJsonObject(schema) || !['string', 'number', 'integer', 'boolean'].includes(String(schema.type))) return undefined;
    const options = Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === 'string') : [];
    fields.push({
      id,
      label: typeof schema.title === 'string' ? schema.title : id,
      description: typeof schema.description === 'string' ? schema.description : '',
      type: schema.type === 'boolean' ? 'boolean' : schema.type === 'number' || schema.type === 'integer' ? 'number' : 'string',
      required: required.has(id),
      secret: schema.format === 'password',
      options
    });
  }
  return fields.length <= 20 ? fields : undefined;
}

function permissionDetails(value: Record<string, unknown>): string[] {
  const details: string[] = [];
  if (isJsonObject(value.network)) details.push(value.network.enabled === true ? 'Network access' : 'Additional network rules');
  if (isJsonObject(value.fileSystem)) {
    const read = Array.isArray(value.fileSystem.read) ? value.fileSystem.read.filter((item) => typeof item === 'string') : [];
    const write = Array.isArray(value.fileSystem.write) ? value.fileSystem.write.filter((item) => typeof item === 'string') : [];
    if (read.length) details.push(`Read: ${read.join(', ')}`);
    if (write.length) details.push(`Write: ${write.join(', ')}`);
    if (!read.length && !write.length) details.push('Additional file access');
  }
  return details.length ? details : ['Additional sandbox permissions'];
}

function networkDetail(value: unknown): string | undefined {
  return isJsonObject(value) && typeof value.host === 'string'
    ? `Network: ${String(value.protocol ?? 'network')}://${value.host}`
    : undefined;
}

function optionalText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function compact(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => Boolean(value));
}
