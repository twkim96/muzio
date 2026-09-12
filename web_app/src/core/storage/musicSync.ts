import type { PlaylistRecord } from './playlistRepository';

export type Cell<T> = { value: T; revision: number };
export type SyncedPlaylist = {
  id: string; name: Cell<string>; deleted: Cell<boolean>;
  items: Record<string, Cell<boolean>>; order: Cell<string[]>; createdAt: string;
};
export type MusicSnapshot = {
  revision: number; likes: Record<string, Cell<boolean>>; playlists: Record<string, SyncedPlaylist>;
};
export type MusicOperation = {
  id: string; kind: 'like' | 'create' | 'name' | 'delete' | 'item' | 'order';
  playlistId?: string; key?: string; value: boolean | string | string[]; baseRevision: number;
};
type Pending = MusicOperation & { after?: string; queuedAt: number };
export type MusicResult = { id: string; status: 'applied' | 'noop' | 'conflict'; revision: number; canonicalId?: string };
export interface MusicSyncClient {
  get(revision?: number): Promise<MusicSnapshot | null>;
  post(operations: MusicOperation[]): Promise<{ snapshot: MusicSnapshot; results: MusicResult[] }>;
}
const PREFIX = 'music.sync.v1.';
const LIKES = 'music.likes.v1';
const PLAYLISTS = 'music.playlists.v1';
export const MUSIC_SYNC_EVENT = 'muzio-music-sync';
const empty = (): MusicSnapshot => ({ revision: 0, likes: {}, playlists: {} });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (op: MusicOperation) => `${op.kind}:${op.playlistId ?? ''}:${op.key ?? ''}`;
const sharedKey = (key: string) => key.trim() !== '' && !key.startsWith('local:');

export function createMusicSyncClient(): MusicSyncClient {
  const request = async (init: RequestInit) => {
    const response = await fetch('/api/music-sync', { ...init, signal: AbortSignal.timeout(15000) });
    if (response.status !== 304 && !response.ok) throw new Error(`Music sync: ${response.status}`);
    return response;
  };
  return {
    async get(revision) {
      const response = await request({ headers: revision === undefined ? {} : { 'If-None-Match': `"music-sync-${revision}"` }, cache: 'no-cache' });
      return response.status === 304 ? null : response.json();
    },
    async post(operations) {
      const response = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operations }) });
      return response.json();
    },
  };
}

/** Durable explicit edits. Each operation has its own key, so other tabs never
 * overwrite a shared outbox array. Web Locks serialize network acknowledgments. */
export class MusicSync {
  private snapshot: MusicSnapshot;
  private running: Promise<void> | null = null;
  private stopped = false;
  private wake: (() => void) | undefined;
  beforeSync?: () => Promise<void>;
  private status: 'idle' | 'pending' | 'offline' = 'idle';
  constructor(private storage: Storage, private client: MusicSyncClient, private changed: () => void = () => {}) {
    this.snapshot = this.read<MusicSnapshot>('snapshot') ?? empty();
  }
  private read<T>(key: string): T | undefined {
    try { return JSON.parse(this.storage.getItem(PREFIX + key) ?? 'null') ?? undefined; } catch { return undefined; }
  }
  private pending(): Pending[] {
    const pending: Pending[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(PREFIX + 'op.')) continue;
      const value = this.read<Pending>(key.slice(PREFIX.length));
      if (value?.id) pending.push(value);
    }
    return pending.sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  }
  private writePending(op: Pending) { this.storage.setItem(PREFIX + 'op.' + op.id, JSON.stringify(op)); }
  private refreshSnapshot() {
    const saved = this.read<MusicSnapshot>('snapshot');
    if (saved && saved.revision >= this.snapshot.revision) this.snapshot = saved;
  }
  private revision(op: Omit<MusicOperation, 'id' | 'baseRevision'>): number {
    if (op.kind === 'like') return this.snapshot.likes[op.key!]?.revision ?? 0;
    const playlist = this.snapshot.playlists[op.playlistId!];
    if (op.kind === 'item') return playlist?.items[op.key!]?.revision ?? 0;
    if (op.kind === 'name') return playlist?.name.revision ?? 0;
    if (op.kind === 'delete') return playlist?.deleted.revision ?? 0;
    if (op.kind === 'order') return playlist?.order.revision ?? 0;
    return 0;
  }
  private enqueue(change: Omit<MusicOperation, 'id' | 'baseRevision'>) {
    this.refreshSnapshot();
    const prior = this.pending();
    const operation: Pending = { ...change, id: crypto.randomUUID(), baseRevision: this.revision(change), queuedAt: Math.max(Date.now(), ...prior.map(op => op.queuedAt + 1)) };
    const previous = prior.filter(op => identity(op) === identity(operation)).at(-1);
    // A local follow-up depends on our earlier edit, not on a stale remote state.
    const creation = prior.find(op => op.kind === 'create' && op.playlistId === operation.playlistId);
    const after = previous ?? creation;
    if (after) operation.after = after.id;
    this.writePending(operation);
    this.status = 'pending';
    this.wake?.();
  }
  recordLikes(before: readonly string[], after: readonly string[]) {
    const old = new Set(before); const next = new Set(after);
    for (const key of new Set([...old, ...next])) {
      if (sharedKey(key) && old.has(key) !== next.has(key)) this.enqueue({ kind: 'like', key, value: next.has(key) });
    }
  }
  recordPlaylists(before: readonly PlaylistRecord[], after: readonly PlaylistRecord[]) {
    const prior = new Map(before.map(p => [p.id, p]));
    for (const old of before) {
      if (!after.some(p => p.id === old.id)) this.enqueue({ kind: 'delete', playlistId: old.id, value: true });
    }
    for (const next of after) {
      const old = prior.get(next.id);
      if (!old) this.enqueue({ kind: 'create', playlistId: next.id, value: next.name });
      else if (old.name !== next.name) this.enqueue({ kind: 'name', playlistId: next.id, value: next.name });
      const oldKeys = new Set(old?.items.map(item => item.contentKey) ?? []);
      const newKeys = new Set(next.items.map(item => item.contentKey));
      for (const key of new Set([...oldKeys, ...newKeys])) {
        if (sharedKey(key) && oldKeys.has(key) !== newKeys.has(key)) this.enqueue({ kind: 'item', playlistId: next.id, key, value: newKeys.has(key) });
      }
      // Membership changes preserve server order; reorder only existing members.
      const oldCommon = (old?.items ?? []).map(item => item.contentKey).filter(key => newKeys.has(key) && sharedKey(key));
      const newCommon = next.items.map(item => item.contentKey).filter(key => oldKeys.has(key) && sharedKey(key));
      if (!old || !equal(oldCommon, newCommon)) this.enqueue({ kind: 'order', playlistId: next.id, value: next.items.map(item => item.contentKey).filter(sharedKey) });
    }
  }
  private importOnce() {
    if (this.storage.getItem(PREFIX + 'imported')) return;
    const likes: string[] = JSON.parse(this.storage.getItem(LIKES) ?? '[]');
    const playlists: PlaylistRecord[] = JSON.parse(this.storage.getItem(PLAYLISTS) ?? '{"playlists":[]}').playlists;
    const pending = this.pending();
    // Absence on one old device is not a deletion. Existing server tombstones
    // win over a legacy import; only an explicit new user action can change them.
    for (const key of likes.filter(sharedKey)) {
      if (!this.snapshot.likes[key] && !pending.some(op => op.kind === 'like' && op.key === key)) this.enqueue({ kind: 'like', key, value: true });
    }
    for (const local of playlists) {
      const byID = this.snapshot.playlists[local.id];
      if (byID?.deleted.value) continue;
      const shared = byID ?? Object.values(this.snapshot.playlists).find(p => !p.deleted.value && p.name.value === local.name);
      if (!shared && Object.values(this.snapshot.playlists).some(p => p.deleted.value && p.name.value === local.name)) continue;
      const id = shared?.id ?? local.id;
      if (!shared && !pending.some(op => op.kind === 'create' && op.playlistId === id)) this.enqueue({ kind: 'create', playlistId: id, value: local.name });
      for (const item of local.items) {
        if (sharedKey(item.contentKey) && !shared?.items[item.contentKey] && !pending.some(op => op.kind === 'item' && op.playlistId === id && op.key === item.contentKey)) {
          this.enqueue({ kind: 'item', playlistId: id, key: item.contentKey, value: true });
        }
      }
      if (!shared && !pending.some(op => op.kind === 'order' && op.playlistId === id)) {
        this.enqueue({ kind: 'order', playlistId: id, value: local.items.map(item => item.contentKey).filter(sharedKey) });
      }
    }
    this.storage.setItem(PREFIX + 'imported', '1');
  }
  private project() {
    const state = structuredClone(this.snapshot);
    for (const op of this.pending()) {
      const cell = { value: op.value, revision: op.baseRevision };
      if (op.kind === 'like') state.likes[op.key!] = cell as Cell<boolean>;
      else if (op.kind === 'create' && !state.playlists[op.playlistId!]) {
        state.playlists[op.playlistId!] = { id: op.playlistId!, name: cell as Cell<string>, deleted: { value: false, revision: 0 }, items: {}, order: { value: [], revision: 0 }, createdAt: new Date(op.queuedAt).toISOString() };
      } else {
        const playlist = state.playlists[op.playlistId!];
        if (!playlist || playlist.deleted.value) continue;
        if (op.kind === 'delete') playlist.deleted = cell as Cell<boolean>;
        if (op.kind === 'name') playlist.name = cell as Cell<string>;
        if (op.kind === 'item') playlist.items[op.key!] = cell as Cell<boolean>;
        if (op.kind === 'order') playlist.order = cell as Cell<string[]>;
      }
    }
    const oldLikes: string[] = JSON.parse(this.storage.getItem(LIKES) ?? '[]');
    const likes = [...oldLikes.filter(key => !sharedKey(key)), ...Object.keys(state.likes).filter(key => state.likes[key].value)];
    const oldPlaylists: PlaylistRecord[] = JSON.parse(this.storage.getItem(PLAYLISTS) ?? '{"playlists":[]}').playlists;
    const playlists: PlaylistRecord[] = Object.values(state.playlists).filter(p => !p.deleted.value).map(p => {
      const members = Object.keys(p.items).filter(key => p.items[key].value).sort((a, b) => p.items[a].revision - p.items[b].revision || a.localeCompare(b));
      const keys = [...new Set([...p.order.value.filter(key => members.includes(key)), ...members])];
      const old = oldPlaylists.find(item => item.id === p.id);
      return { id: p.id, name: p.name.value, createdAt: p.createdAt, updatedAt: old?.updatedAt ?? p.createdAt,
        items: [...keys.map(contentKey => ({ contentKey, addedAt: old?.items.find(item => item.contentKey === contentKey)?.addedAt ?? p.createdAt })), ...(old?.items.filter(item => !sharedKey(item.contentKey)) ?? [])] };
    });
    const likesJSON = JSON.stringify(likes);
    const playlistsJSON = JSON.stringify({ version: 1, playlists });
    const changed = this.storage.getItem(LIKES) !== likesJSON || this.storage.getItem(PLAYLISTS) !== playlistsJSON;
    if (changed) {
      this.storage.setItem(LIKES, likesJSON);
      this.storage.setItem(PLAYLISTS, playlistsJSON);
      this.changed();
    }
  }
  private accept(snapshot: MusicSnapshot) {
    this.refreshSnapshot();
    if (snapshot.revision < this.snapshot.revision) return;
    this.snapshot = snapshot;
    this.storage.setItem(PREFIX + 'snapshot', JSON.stringify(snapshot));
  }
  private acknowledge(results: MusicResult[], sent: Pending[]) {
    for (const result of results) {
      const op = sent.find(candidate => candidate.id === result.id);
      if (!op) continue;
      // Rewrite dependents durably before deleting the acknowledged parent.
      for (const next of this.pending()) {
        if (next.id === op.id || this.storage.getItem(PREFIX + 'op.' + next.id) === null) continue;
        if (result.canonicalId && next.playlistId === op.playlistId) next.playlistId = result.canonicalId;
        if (next.after === op.id) {
          if (result.status === 'conflict') {
            this.storage.removeItem(PREFIX + 'op.' + next.id);
            this.dropDependents(next.id);
            continue;
          }
          delete next.after;
          next.baseRevision = this.revision(next);
        }
        this.writePending(next);
      }
      this.storage.removeItem(PREFIX + 'op.' + op.id);
    }
  }
  private dropDependents(id: string) {
    for (const op of this.pending()) if (op.after === id) {
      this.storage.removeItem(PREFIX + 'op.' + op.id); this.dropDependents(op.id);
    }
  }
  async sync(): Promise<void> {
    if (this.stopped) return;
    if (this.running) return this.running;
    const work = async () => {
      try {
        await this.beforeSync?.();
        this.refreshSnapshot();
        const remote = await this.client.get(this.read('snapshot') ? this.snapshot.revision : undefined);
        if (remote) this.accept(remote);
        this.importOnce();
        for (let round = 0; round < 20 && !this.stopped; round++) {
          const pending = this.pending();
          if (!pending.length) break;
          const ids = new Set(pending.map(op => op.id));
          const sent = pending.filter(op => !op.after || !ids.has(op.after)).slice(0, 128);
          const response = await this.client.post(sent.map(({ after: _after, queuedAt: _queuedAt, ...op }) => op));
          this.accept(response.snapshot);
          this.acknowledge(response.results, sent);
        }
        this.project();
        this.status = this.pending().length ? 'pending' : 'idle';
      } catch {
        this.status = 'offline';
        // Leave unacknowledged edits durable. Never replace local UI on failure.
      }
    };
    this.running = (typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('muzio-music-sync', work) : work()).finally(() => { this.running = null; });
    return this.running;
  }
  start() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (this.stopped) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void this.sync(); }, 200);
    };
    this.wake = schedule;
    const resume = () => { if (document.visibilityState !== 'hidden') schedule(); };
    const storage = (event: StorageEvent) => { if (event.key?.startsWith(PREFIX)) { this.refreshSnapshot(); if (this.storage.getItem(PREFIX + 'imported')) this.project(); resume(); } };
    window.addEventListener('online', resume);
    window.addEventListener('muzio-resume', resume);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('storage', storage);
    const interval = setInterval(resume, 15000);
    schedule();
    return () => {
      this.stopped = true; clearTimeout(timer); clearInterval(interval);
      window.removeEventListener('online', resume); window.removeEventListener('muzio-resume', resume);
      document.removeEventListener('visibilitychange', resume); window.removeEventListener('storage', storage);
    };
  }
  getStatus() { return this.status; }
}

let activeSync: MusicSync | undefined;
export function musicSync() { return activeSync; }
export function enableMusicSync(storage: Storage = localStorage, client = createMusicSyncClient()) {
  activeSync = new MusicSync(storage, client, () => window.dispatchEvent(new Event(MUSIC_SYNC_EVENT)));
  return activeSync;
}
