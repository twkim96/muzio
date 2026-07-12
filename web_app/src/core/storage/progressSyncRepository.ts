import {
  deleteProgressRecord,
  fetchProgressRecords,
  putProgressRecord,
  type RemoteProgressRecord,
} from '../api/progressClient';
import type {
  ProgressRecord,
  ProgressRepository,
} from './progressRepository';

export interface ProgressSyncClient {
  list(): Promise<RemoteProgressRecord[]>;
  put(mediaId: string, record: ProgressRecord): Promise<void>;
  delete(mediaId: string): Promise<void>;
}

export interface SyncedProgressRepository extends ProgressRepository {
  syncFromRemote(): Promise<void>;
}

export function createDefaultProgressSyncClient(): ProgressSyncClient {
  return {
    async list() {
      const result = await fetchProgressRecords();
      if (result.kind !== 'ok') throw new Error('progress sync list failed');
      return result.value;
    },
    async put(mediaId, record) {
      const result = await putProgressRecord(mediaId, record);
      if (result.kind !== 'ok') throw new Error('progress sync put failed');
    },
    async delete(mediaId) {
      const result = await deleteProgressRecord(mediaId);
      if (result.kind !== 'ok') throw new Error('progress sync delete failed');
    },
  };
}

export function createSyncedProgressRepository(
  local: ProgressRepository,
  client: ProgressSyncClient = createDefaultProgressSyncClient(),
): SyncedProgressRepository {
  return {
    read(mediaId) {
      return local.read(mediaId);
    },
    write(mediaId, record) {
      local.write(mediaId, record);
      void client.put(mediaId, record).catch(() => {});
    },
    clear(mediaId) {
      local.clear(mediaId);
      void client.delete(mediaId).catch(() => {});
    },
    entries() {
      return local.entries();
    },
    mergeMany(entries) {
      if (local.mergeMany !== undefined) {
        local.mergeMany(entries);
        return;
      }
      for (const [mediaId, record] of entries) local.write(mediaId, record);
    },
    subscribe(mediaId, listener) {
      return local.subscribe?.(mediaId, listener) ?? (() => {});
    },
    mostRecent() {
      return local.mostRecent();
    },
    async syncFromRemote() {
      let records: RemoteProgressRecord[];
      try {
        records = await client.list();
      } catch {
        return;
      }
      const updates: Array<readonly [string, ProgressRecord]> = [];
      for (const record of records) {
        const localRecord = local.read(record.mediaId);
        if (isNewer(record, localRecord)) {
          updates.push([record.mediaId, toLocalRecord(record)]);
        }
      }
      if (updates.length === 0) return;
      if (local.mergeMany !== undefined) {
        local.mergeMany(updates);
        return;
      }
      for (const [mediaId, record] of updates) local.write(mediaId, record);
    },
  };
}

function isNewer(
  remote: RemoteProgressRecord,
  localRecord: ProgressRecord | null,
): boolean {
  if (localRecord === null) return true;
  const remoteStamp = Date.parse(remote.lastPlayedAt);
  const localStamp = Date.parse(localRecord.lastPlayedAt);
  if (!Number.isFinite(remoteStamp)) return false;
  if (!Number.isFinite(localStamp)) return true;
  return remoteStamp > localStamp;
}

function toLocalRecord(record: RemoteProgressRecord): ProgressRecord {
  return {
    positionSec: record.positionSec,
    durationSec: record.durationSec,
    lastPlayedAt: record.lastPlayedAt,
    ...(record.source !== undefined ? { source: record.source } : {}),
  };
}
