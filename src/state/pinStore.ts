import * as vscode from 'vscode';

const PINNED_THREAD_IDS_KEY = 'codexThreadManager.pinnedThreadIds';

export class PinStore {
  public constructor(private readonly state: vscode.Memento) {}

  public getPinnedThreadIds(): readonly string[] {
    const value = this.state.get<unknown>(PINNED_THREAD_IDS_KEY, []);
    if (!Array.isArray(value)) {
      return [];
    }
    return uniqueThreadIds(value);
  }

  public isPinned(threadId: string): boolean {
    return this.getPinnedThreadIds().includes(threadId);
  }

  public async pin(threadId: string): Promise<void> {
    const next = [threadId, ...this.getPinnedThreadIds().filter((id) => id !== threadId)];
    await this.state.update(PINNED_THREAD_IDS_KEY, next);
  }

  public async unpin(threadId: string): Promise<void> {
    await this.state.update(
      PINNED_THREAD_IDS_KEY,
      this.getPinnedThreadIds().filter((id) => id !== threadId)
    );
  }

  public async pruneExistingThreadIds(existingThreadIds: readonly string[]): Promise<void> {
    const existing = new Set(existingThreadIds);
    const current = this.getPinnedThreadIds();
    const next = current.filter((id) => existing.has(id));
    if (next.length !== current.length) {
      await this.state.update(PINNED_THREAD_IDS_KEY, next);
    }
  }
}

function uniqueThreadIds(value: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}
