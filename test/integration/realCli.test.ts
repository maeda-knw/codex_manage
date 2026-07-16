import assert from 'node:assert/strict';
import test from 'node:test';
import { AppServerClient } from '../../src/codex/appServerClient';

const codexPath = process.env.CODEX_SMOKE_PATH;

test('opt-in real CLI lists metadata and validates one stored conversation shape', {
  skip: codexPath ? false : 'Set CODEX_SMOKE_PATH to run the read-only real CLI smoke test.'
}, async (t) => {
  const logs: string[] = [];
  const client = new AppServerClient({
    codexPath: codexPath ?? 'codex',
    clientVersion: '0.0.1-smoke',
    logger: { appendLine: (value) => logs.push(value) }
  });
  t.after(() => client.dispose());

  const page = await client.listThreads({
    limit: 1,
    sortKey: 'recency_at',
    sortDirection: 'desc',
    archived: false,
    cwd: [process.cwd()]
  });

  assert.equal(Array.isArray(page.data), true);
  assert.equal(client.getDiagnostics().compatibility, 'compatible');
  assert.equal(logs.some((line) => line.includes('response boundaries are compatible')), true);

  const thread = page.data[0];
  if (thread) {
    const response = await client.readThread({
      threadId: thread.id,
      includeTurns: true
    });
    assert.equal(response.thread.id, thread.id);
    assert.equal(Array.isArray(response.thread.turns), true);
  }
});
