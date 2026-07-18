import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConversationInteractionResponse,
  parseConversationInteraction
} from '../../src/conversation/conversationInteraction';

test('parses command approvals without exposing policy amendment payloads', () => {
  const interaction = parseConversationInteraction('request-1', 'interaction-1', 'item/commandExecution/requestApproval', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    startedAtMs: 1,
    command: 'npm test',
    cwd: '/workspace',
    reason: 'Run tests outside the sandbox',
    proposedExecpolicyAmendment: { command: 'fixture' }
  });
  assert.ok(interaction);
  assert.equal(interaction.view.kind, 'commandApproval');
  assert.deepEqual(interaction.view.kind === 'commandApproval' ? interaction.view.detail : [], [
    'npm test',
    'Working directory: /workspace'
  ]);
  assert.deepEqual(buildConversationInteractionResponse(interaction, {
    kind: 'approval', decision: 'decline'
  }), { decision: 'decline' });
});

test('validates every requested answer before responding', () => {
  const interaction = parseConversationInteraction(7, 'interaction-2', 'item/tool/requestUserInput', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-2',
    autoResolutionMs: null,
    questions: [{
      id: 'color',
      header: 'Color',
      question: 'Choose a color',
      isOther: true,
      isSecret: false,
      options: [{ label: 'Blue', description: 'Use blue' }]
    }]
  });
  assert.ok(interaction);
  assert.equal(buildConversationInteractionResponse(interaction, { kind: 'userInput', answers: {} }), undefined);
  assert.deepEqual(buildConversationInteractionResponse(interaction, {
    kind: 'userInput', answers: { color: ['Blue'] }
  }), { answers: { color: { answers: ['Blue'] } } });
});

test('supports typed MCP forms and safely limits unknown form modes', () => {
  const interaction = parseConversationInteraction('mcp-1', 'interaction-3', 'mcpServer/elicitation/request', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    serverName: 'fixture',
    mode: 'form',
    _meta: null,
    message: 'Configure the fixture',
    requestedSchema: {
      type: 'object',
      properties: { name: { type: 'string', title: 'Name' }, enabled: { type: 'boolean' } },
      required: ['name']
    }
  });
  assert.ok(interaction);
  assert.deepEqual(buildConversationInteractionResponse(interaction, {
    kind: 'mcp', action: 'accept', values: { name: 'demo', enabled: true }
  }), { action: 'accept', content: { name: 'demo', enabled: true }, _meta: null });
});
