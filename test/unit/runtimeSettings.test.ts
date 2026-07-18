import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationRuntimeSettings } from '../../src/conversation/conversationSession';
import { runtimeSettingsSummary } from '../../src/webview/threads/runtimeSettings';

function runtime(overrides: Partial<ConversationRuntimeSettings> = {}): ConversationRuntimeSettings {
  return {
    status: 'ready',
    models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Frontier' }],
    model: 'gpt-5.6-sol',
    efforts: [{ value: 'low', label: 'Low', description: 'Fast' }],
    effort: null,
    defaultEffort: 'low',
    serviceTiers: [{ value: 'priority', label: 'Fast', description: 'Lower latency' }],
    serviceTier: null,
    defaultServiceTier: null,
    sandbox: 'workspace-write',
    approvalPolicy: 'custom',
    message: null,
    ...overrides
  };
}

test('summarizes the compact model, effective effort, and workspace permission without default labels', () => {
  assert.equal(
    runtimeSettingsSummary(runtime()),
    '5.6 Sol · Low · Workspace'
  );
});

test('shows speed only when Fast is effective and maps full access permission', () => {
  assert.equal(runtimeSettingsSummary(runtime({
    models: [{ value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Frontier' }],
    model: 'gpt-5.6-terra',
    efforts: [{ value: 'high', label: 'High', description: 'Thorough' }],
    effort: 'high',
    defaultEffort: 'low',
    serviceTier: 'priority',
    sandbox: 'danger-full-access'
  })), '5.6 Terra · High · Fast · Full access');

  assert.equal(runtimeSettingsSummary(runtime({
    serviceTiers: [{ value: 'flex', label: 'Flexible', description: 'Lower priority' }],
    serviceTier: 'flex',
    sandbox: 'read-only'
  })), '5.6 Sol · Low · Read only');

  assert.equal(runtimeSettingsSummary(runtime({
    defaultServiceTier: 'priority'
  })), '5.6 Sol · Low · Fast · Workspace');
});

test('distinguishes unavailable and unlisted runtime values without blank labels', () => {
  assert.equal(runtimeSettingsSummary(runtime({ status: 'unavailable' })), 'Unavailable');
  assert.equal(runtimeSettingsSummary(runtime({
    models: [{ value: 'private-model', label: 'private-model (current, unlisted)', description: 'Current' }],
    model: 'private-model',
    efforts: [{ value: 'ultra', label: 'Ultra (current, unlisted)', description: 'Current' }],
    effort: 'ultra',
    defaultEffort: null,
    serviceTiers: [],
    serviceTier: null,
    defaultServiceTier: null
  })), 'private-model · Ultra · Workspace');
});
