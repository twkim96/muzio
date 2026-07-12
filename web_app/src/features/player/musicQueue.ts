import type { PlaybackSource } from '../../core/playback/source/source';

export type RepeatMode = 'none' | 'all' | 'one';
export type QueueMoveDirection = 'up' | 'down';

export interface MusicQueueSnapshot {
  tracks: PlaybackSource[];
  currentIndex: number;
  repeatMode: RepeatMode;
  stopAfterCurrent: boolean;
}

export function buildMusicQueue(
  tracks: readonly PlaybackSource[],
  startMediaId: string,
): { tracks: PlaybackSource[]; currentIndex: number } {
  const audioTracks = tracks.filter((track) => track.mediaType === 'audio');
  const index = audioTracks.findIndex((track) => track.mediaId === startMediaId);
  return {
    tracks: audioTracks,
    currentIndex: index >= 0 ? index : 0,
  };
}

export function queueTrackKey(track: PlaybackSource): string {
  return track.queueEntryId ?? track.mediaId;
}

function matchesQueueTrack(track: PlaybackSource, trackKey: string): boolean {
  return queueTrackKey(track) === trackKey || track.mediaId === trackKey;
}

export function findQueueTrackIndex(
  tracks: readonly PlaybackSource[],
  trackKey: string,
): number {
  return tracks.findIndex((track) => matchesQueueTrack(track, trackKey));
}

export function currentQueueTrack(
  tracks: readonly PlaybackSource[],
  currentIndex: number,
): PlaybackSource | null {
  if (currentIndex < 0 || currentIndex >= tracks.length) return null;
  return tracks[currentIndex] ?? null;
}

export function insertQueueTrackAfterCurrent(
  tracks: readonly PlaybackSource[],
  currentIndex: number,
  source: PlaybackSource,
): { tracks: PlaybackSource[]; currentIndex: number } {
  if (currentQueueTrack(tracks, currentIndex) === null) {
    return { tracks: [source], currentIndex: 0 };
  }
  const nextTracks = [...tracks];
  const insertIndex = currentIndex + 1;
  nextTracks.splice(insertIndex, 0, source);
  return { tracks: nextTracks, currentIndex: insertIndex };
}

export function nextRepeatMode(mode: RepeatMode): RepeatMode {
  if (mode === 'none') return 'all';
  if (mode === 'all') return 'one';
  return 'none';
}

export function nextQueueIndex(queue: MusicQueueSnapshot): number | null {
  const length = queue.tracks.length;
  if (length === 0 || queue.currentIndex < 0 || queue.currentIndex >= length) {
    return null;
  }
  if (queue.stopAfterCurrent) return null;
  if (queue.repeatMode === 'one') return queue.currentIndex;
  if (queue.currentIndex < length - 1) return queue.currentIndex + 1;
  return queue.repeatMode === 'all' ? 0 : null;
}

export function previousQueueIndex(queue: MusicQueueSnapshot): number | null {
  const length = queue.tracks.length;
  if (length <= 1 || queue.currentIndex < 0 || queue.currentIndex >= length) {
    return null;
  }
  if (queue.currentIndex > 0) return queue.currentIndex - 1;
  return queue.repeatMode === 'all' ? length - 1 : null;
}

export function explicitNextQueueIndex(queue: MusicQueueSnapshot): number | null {
  const length = queue.tracks.length;
  if (length <= 1 || queue.currentIndex < 0 || queue.currentIndex >= length) {
    return null;
  }
  if (queue.currentIndex < length - 1) return queue.currentIndex + 1;
  return queue.repeatMode === 'all' ? 0 : null;
}

export function shuffleQueueKeepingCurrent(
  tracks: readonly PlaybackSource[],
  currentIndex: number,
  random: () => number = Math.random,
): { tracks: PlaybackSource[]; currentIndex: number } {
  const current = currentQueueTrack(tracks, currentIndex);
  if (current === null) {
    return { tracks: [...tracks], currentIndex };
  }
  const remaining = tracks.filter((_, index) => index !== currentIndex);
  for (let index = remaining.length - 1; index > 0; index -= 1) {
    const bounded = Math.min(0.999999, Math.max(0, random()));
    const swapIndex = Math.floor(bounded * (index + 1));
    [remaining[index], remaining[swapIndex]] = [
      remaining[swapIndex],
      remaining[index],
    ];
  }
  return { tracks: [current, ...remaining], currentIndex: 0 };
}

export function removeQueueTrack(
  tracks: readonly PlaybackSource[],
  currentIndex: number,
  trackKey: string,
): { tracks: PlaybackSource[]; currentIndex: number } {
  const index = tracks.findIndex((track) => matchesQueueTrack(track, trackKey));
  if (index < 0) {
    return { tracks: [...tracks], currentIndex };
  }
  const nextTracks = tracks.filter((track) => !matchesQueueTrack(track, trackKey));
  if (nextTracks.length === 0) {
    return { tracks: [], currentIndex: -1 };
  }
  if (index < currentIndex) {
    return { tracks: nextTracks, currentIndex: currentIndex - 1 };
  }
  if (index === currentIndex) {
    return {
      tracks: nextTracks,
      currentIndex: Math.min(currentIndex, nextTracks.length - 1),
    };
  }
  return { tracks: nextTracks, currentIndex };
}

export function clearQueueTracks(
  tracks: readonly PlaybackSource[],
  currentIndex: number,
): { tracks: PlaybackSource[]; currentIndex: number } {
  const current = currentQueueTrack(tracks, currentIndex);
  if (current === null) return { tracks: [], currentIndex: -1 };
  return { tracks: [current], currentIndex: 0 };
}

export function moveQueueTrackNext(
  tracks: readonly PlaybackSource[],
  currentIndex: number,
  trackKey: string,
): { tracks: PlaybackSource[]; currentIndex: number } {
  if (currentQueueTrack(tracks, currentIndex) === null) {
    return { tracks: [...tracks], currentIndex };
  }
  const from = tracks.findIndex((track) => matchesQueueTrack(track, trackKey));
  if (from < 0 || from === currentIndex) {
    return { tracks: [...tracks], currentIndex };
  }

  const nextTracks = [...tracks];
  const [moved] = nextTracks.splice(from, 1);
  const nextIndex = from < currentIndex ? currentIndex - 1 : currentIndex;
  nextTracks.splice(nextIndex + 1, 0, moved);

  return { tracks: nextTracks, currentIndex: nextIndex };
}

export function moveQueueTrack(
  tracks: readonly PlaybackSource[],
  currentIndex: number,
  trackKey: string,
  direction: QueueMoveDirection,
): { tracks: PlaybackSource[]; currentIndex: number } {
  const from = tracks.findIndex((track) => matchesQueueTrack(track, trackKey));
  if (from < 0) return { tracks: [...tracks], currentIndex };
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= tracks.length) {
    return { tracks: [...tracks], currentIndex };
  }
  const nextTracks = [...tracks];
  const [moved] = nextTracks.splice(from, 1);
  nextTracks.splice(to, 0, moved);

  let nextIndex = currentIndex;
  if (currentIndex === from) nextIndex = to;
  else if (from < currentIndex && to >= currentIndex) nextIndex -= 1;
  else if (from > currentIndex && to <= currentIndex) nextIndex += 1;

  return { tracks: nextTracks, currentIndex: nextIndex };
}
