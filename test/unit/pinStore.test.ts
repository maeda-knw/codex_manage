import assert from 'node:assert/strict';
import test from 'node:test';
import type { Memento } from 'vscode';
import { PinStore } from '../../src/state/pinStore';

class MemoryMemento {
  private readonly values = new Map<string, unknown>();
  public readonly updates: Array<{ key: string; value: unknown }> = [];

  public get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    this.updates.push({ key, value });
  }

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

function createStore(state = new MemoryMemento()): { state: MemoryMemento; store: PinStore } {
  return { state, store: new PinStore(state as Memento) };
}

test('stores newest pins first and preserves the order across store instances', async () => {
  const state = new MemoryMemento();
  const store = new PinStore(state as Memento);

  await store.pin('thread-a');
  await store.pin('thread-b');
  await store.pin('thread-a');

  assert.deepEqual(store.getPinnedThreadIds(), ['thread-a', 'thread-b']);
  assert.deepEqual(new PinStore(state as Memento).getPinnedThreadIds(), ['thread-a', 'thread-b']);
});

test('sanitizes corrupt state, removes duplicates, and unpins a thread', async () => {
  const { state, store } = createStore();
  state.set('codexThreadManager.pinnedThreadIds', ['thread-a', '', 42, 'thread-a', 'thread-b']);

  assert.deepEqual(store.getPinnedThreadIds(), ['thread-a', 'thread-b']);
  assert.equal(store.isPinned('thread-b'), true);
  await store.unpin('thread-a');
  assert.deepEqual(store.getPinnedThreadIds(), ['thread-b']);
});

test('prunes missing thread IDs without writing when the state is already valid', async () => {
  const { state, store } = createStore();
  await store.pin('thread-a');
  await store.pin('thread-b');
  state.updates.length = 0;

  await store.pruneExistingThreadIds(['thread-a', 'thread-b']);
  assert.equal(state.updates.length, 0);

  await store.pruneExistingThreadIds(['thread-a']);
  assert.deepEqual(store.getPinnedThreadIds(), ['thread-a']);
  assert.equal(state.updates.length, 1);
});
