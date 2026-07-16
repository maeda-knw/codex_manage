import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'compatible';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        userAgent: 'fake-codex/0.142.3',
        codexHome: '<fixture>',
        platformFamily: process.platform,
        platformOs: process.platform
      }
    });
  } else if (message.method === 'thread/list' && mode === 'compatible') {
    send({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: null } });
  } else if (message.method === 'thread/list' && mode === 'malformed') {
    send({ id: message.id, result: { data: 'invalid', nextCursor: null } });
  } else if (message.method === 'thread/list') {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
