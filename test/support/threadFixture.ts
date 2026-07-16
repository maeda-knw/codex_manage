import type { Thread } from '../../src/codex/protocol/generated/v2/Thread';
import type { Turn } from '../../src/codex/protocol/generated/v2/Turn';

export function createThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    sessionId: 'session-1',
    forkedFromId: null,
    parentThreadId: null,
    preview: 'Fixture thread',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1_752_633_600,
    updatedAt: 1_752_633_660,
    recencyAt: 1_752_633_660,
    status: { type: 'idle' },
    path: null,
    cwd: 'D:\\workspace',
    cliVersion: '0.144.2',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides
  };
}

export function createTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-1',
    items: [],
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt: 1_752_633_600,
    completedAt: 1_752_633_602,
    durationMs: 2_000,
    ...overrides
  };
}
