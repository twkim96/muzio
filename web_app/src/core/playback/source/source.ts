import type { LibraryItem } from '../../api/libraryClient';

export type PlayableLibraryItem = Omit<LibraryItem, 'type'> & {
  type: 'audio' | 'video';
};

/**
 * Playback source models. Remote sources stream from the backend. The
 * `queueEntryId` is UI-only identity for duplicated queue rows.
 */
export type PlaybackSource = RemotePlaybackSource;

export interface RemotePlaybackSource {
  kind: 'remote';
  /** Stable media id from the backend; useful as a cache key. */
  mediaId: string;
  /** Stable identity for one Queue row; allows the same media id to repeat. */
  queueEntryId?: string;
  /** "audio" or "video" classification; engines may pick element types. */
  mediaType: 'audio' | 'video';
  /** Streaming URL the engine hands to <audio>/<video>. */
  url: string;
  /** Server-provided MIME for capability checks; optional in case the */
  /** backend omits it later. */
  mimeType?: string;
  /** Display name for surfaces that show what is playing. */
  name: string;
  /** Optional metadata identity fields used by playlist/activity keys. */
  title?: string;
  artist?: string;
  /** Best known media duration from library metadata, used as a resume fallback. */
  durationSec?: number;
  /** Parent media root, mirrored from the listing record. Optional so the */
  /** engine and session test fakes do not have to fabricate library state. */
  rootName?: string;
  /** Forward-slash relative path inside the root. Optional, see above. */
  relativePath?: string;
}

const STREAM_BASE_PATH = '/api/media/';

/**
 * Builds the streaming URL for a media id. Same-origin only; see Phase 4
 * follow-up for the rationale. The id is treated as an opaque token per
 * Phase 2's decision record, so we URL-encode it instead of trusting that
 * future ID strategies (content hash, DB id) will stay path-safe.
 *
 * `startSec` appends an `#t=` media fragment so the browser begins playback
 * at that offset without a separate seek round-trip. Using the fragment
 * (rather than a JS-driven seek) avoids a re-buffer race where the element
 * starts loading from byte 0 and is then asked to jump after metadata
 * arrives.
 */
export function buildStreamingUrl(
  mediaId: string,
  options: { startSec?: number } = {},
): string {
  const trimmed = mediaId.trim();
  if (trimmed === '') {
    throw new Error('buildStreamingUrl: mediaId must not be empty');
  }
  const base = `${STREAM_BASE_PATH}${encodeURIComponent(trimmed)}`;
  const start = options.startSec;
  if (
    start === undefined ||
    !Number.isFinite(start) ||
    start <= 0
  ) {
    return base;
  }
  // Round to 0.1 s so the URL stays stable across repeated normalisations.
  const rounded = Math.round(start * 10) / 10;
  return `${base}#t=${rounded}`;
}

/**
 * Translates a backend library record into a remote playback source. Image
 * records deliberately do not enter playback; image callers should guard with
 * isPlayableLibraryItem before creating a source.
 */
export function remoteSourceFromLibraryItem(
  item: PlayableLibraryItem,
  mimeType?: string,
): RemotePlaybackSource {
  const resolvedMimeType = mimeType ?? item.mimeType;
  return {
    kind: 'remote',
    mediaId: item.id,
    mediaType: item.type,
    url: buildStreamingUrl(item.id),
    ...(resolvedMimeType ? { mimeType: resolvedMimeType } : {}),
    name: item.name,
    ...(item.metadata?.title ? { title: item.metadata.title } : {}),
    ...(item.metadata?.artist ? { artist: item.metadata.artist } : {}),
    ...(typeof item.metadata?.durationSec === 'number'
      ? { durationSec: item.metadata.durationSec }
      : {}),
    rootName: item.rootName,
    relativePath: item.relativePath,
  };
}

export function playbackSourceFromLibraryItem(
  item: PlayableLibraryItem,
): PlaybackSource {
  return remoteSourceFromLibraryItem(item);
}

export function isPlayableLibraryItem(
  item: LibraryItem,
): item is PlayableLibraryItem {
  return item.type === 'audio' || item.type === 'video';
}
