import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '../../src/codex/protocol/generated/v2/Model';
import {
  newConversationPermissions,
  newConversationServiceTier
} from '../../src/views/threadListWebviewProvider';

const model: Model = {
  id: 'gpt-default',
  model: 'gpt-default',
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: 'GPT Default',
  description: 'Default model',
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text'],
  supportsPersonality: false,
  additionalSpeedTiers: ['fast'],
  serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Lower latency' }],
  defaultServiceTier: null,
  isDefault: true
};

test('maps the configurable permission presets to conversation runtime values', () => {
  assert.deepEqual(newConversationPermissions('auto'), {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review'
  });
  assert.deepEqual(newConversationPermissions('ask'), {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user'
  });
  assert.deepEqual(newConversationPermissions('full'), {
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    approvalsReviewer: 'user'
  });
});

test('uses standard speed by default and resolves the selected model fast tier', () => {
  assert.equal(newConversationServiceTier([model], model.id, 'standard', 'priority'), null);
  assert.equal(newConversationServiceTier([model], model.id, 'fast', null), 'priority');
  assert.equal(newConversationServiceTier([], model.id, 'fast', 'priority'), null);
  assert.equal(newConversationServiceTier([model], model.id, undefined, 'priority'), 'priority');
});
