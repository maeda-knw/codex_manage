import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { JsonlTransport } from '../../src/codex/jsonlTransport';

test('parses complete JSONL messages, ignores blank lines, and reports malformed input', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: unknown[] = [];
  const malformed: Error[] = [];
  const transport = new JsonlTransport(input, output, {
    onMessage: (message) => messages.push(message),
    onMalformedLine: (error) => malformed.push(error),
    onError: () => undefined,
    onClose: () => undefined
  });

  input.write('{"id":1}\n\n{"method":"thread/list"}\n{broken}\n');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(messages, [{ id: 1 }, { method: 'thread/list' }]);
  assert.equal(malformed.length, 1);
  transport.dispose();
});

test('buffers split input until a newline and writes one JSON object per line', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: unknown[] = [];
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  const transport = new JsonlTransport(input, output, {
    onMessage: (message) => messages.push(message),
    onMalformedLine: () => undefined,
    onError: () => undefined,
    onClose: () => undefined
  });

  input.write('{"partial":');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, []);
  input.write('true}\n');
  await transport.send({ method: 'initialized' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(messages, [{ partial: true }]);
  assert.equal(written, '{"method":"initialized"}\n');
  transport.dispose();
});

test('reports input closure and rejects sends after disposal', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = false;
  const transport = new JsonlTransport(input, output, {
    onMessage: () => undefined,
    onMalformedLine: () => undefined,
    onError: () => undefined,
    onClose: () => {
      closed = true;
    }
  });

  input.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
  transport.dispose();
  await assert.rejects(transport.send({ id: 1 }), /closed/u);
});
