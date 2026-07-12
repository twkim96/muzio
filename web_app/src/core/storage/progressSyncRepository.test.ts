import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createSyncedProgressRepository,
  type ProgressSyncClient,
} from './progressSyncRepository';
import {
  createLocalStorageProgressRepository,
  type ProgressRecord,
} from './progressRepository';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  setCount = 0;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.setCount += 1;
    this.map.set(key, value);
  }
}

function sample(lastPlayedAt = '2026-06-01T10:00:00Z'): ProgressRecord {
  return {
    positionSec: 20,
    durationSec: 100,
    lastPlayedAt,
  };
}

function client(): ProgressSyncClient {
  return {
    list: vi.fn(async () => []),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

describe('createSyncedProgressRepository', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  test('writes locally and mirrors to the remote client', async () => {
    const local = createLocalStorageProgressRepository(storage);
    const syncClient = client();
    const repo = createSyncedProgressRepository(local, syncClient);

    repo.write('m1', sample());
    await Promise.resolve();

    expect(local.read('m1')?.positionSec).toBe(20);
    expect(syncClient.put).toHaveBeenCalledWith('m1', sample());
  });

  test('remote failures do not block local writes', async () => {
    const local = createLocalStorageProgressRepository(storage);
    const syncClient = client();
    vi.mocked(syncClient.put).mockRejectedValue(new Error('offline'));
    const repo = createSyncedProgressRepository(local, syncClient);

    expect(() => repo.write('m1', sample())).not.toThrow();
    await Promise.resolve();
    expect(local.read('m1')).not.toBeNull();
  });

  test('syncFromRemote imports newer remote records', async () => {
    const local = createLocalStorageProgressRepository(storage);
    local.write('m1', sample('2026-06-01T09:00:00Z'));
    const syncClient = client();
    vi.mocked(syncClient.list).mockResolvedValue([
      {
        mediaId: 'm1',
        positionSec: 50,
        durationSec: 100,
        lastPlayedAt: '2026-06-01T10:00:00Z',
        completed: false,
      },
    ]);
    const repo = createSyncedProgressRepository(local, syncClient);

    await repo.syncFromRemote();

    expect(local.read('m1')?.positionSec).toBe(50);
  });

  test('syncFromRemote keeps newer local records', async () => {
    const local = createLocalStorageProgressRepository(storage);
    local.write('m1', sample('2026-06-01T11:00:00Z'));
    const syncClient = client();
    vi.mocked(syncClient.list).mockResolvedValue([
      {
        mediaId: 'm1',
        positionSec: 50,
        durationSec: 100,
        lastPlayedAt: '2026-06-01T10:00:00Z',
        completed: false,
      },
    ]);
    const repo = createSyncedProgressRepository(local, syncClient);

    await repo.syncFromRemote();

    expect(local.read('m1')?.positionSec).toBe(20);
  });

  test('clear removes local progress and mirrors delete', async () => {
    const local = createLocalStorageProgressRepository(storage);
    local.write('m1', sample());
    const syncClient = client();
    const repo = createSyncedProgressRepository(local, syncClient);

    repo.clear('m1');
    await Promise.resolve();

    expect(local.read('m1')).toBeNull();
    expect(syncClient.delete).toHaveBeenCalledWith('m1');
  });

  test('syncFromRemote batches many newer records into one local write', async () => {
    const local = createLocalStorageProgressRepository(storage);
    const syncClient = client();
    vi.mocked(syncClient.list).mockResolvedValue(
      Array.from({ length: 1_000 }, (_, index) => ({
        mediaId: `media-${index}`,
        positionSec: index,
        durationSec: 10_000,
        lastPlayedAt: '2026-06-01T10:00:00Z',
        completed: false,
      })),
    );
    const repo = createSyncedProgressRepository(local, syncClient);
    storage.setCount = 0;

    await repo.syncFromRemote();

    expect(storage.setCount).toBe(1);
    expect(local.entries()).toHaveLength(1_000);
  });
});
