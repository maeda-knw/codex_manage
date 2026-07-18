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

test('summarizes the current model, effective default effort, and available speed', () => {
  assert.equal(
    runtimeSettingsSummary(runtime()),
    'GPT-5.6-Sol · Default (Low) · Default speed'
  );
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
  })), 'private-model (current, unlisted) · Ultra (current, unlisted)');
});
