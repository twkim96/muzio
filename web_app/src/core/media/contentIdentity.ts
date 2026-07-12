import type { LibraryItem, LibraryMediaType } from '../api/libraryClient';
import type { PlaybackSource } from '../playback/source/source';

export interface ContentIdentity {
  key: string;
  title: string;
  artist: string | null;
}

export interface ContentIdentityInput {
  name: string;
  mediaType: LibraryMediaType;
}

const EXTENSION_RE = /\.[^.]+$/;

export function contentIdentityForLibraryItem(
  item: LibraryItem,
): ContentIdentity {
  return contentIdentityForParts({
    mediaType: item.type,
    name: item.name,
    title: item.metadata?.title,
    artist: item.metadata?.artist,
  });
}

export function contentIdentityForPlaybackSource(
  source: PlaybackSource,
): ContentIdentity {
  return contentIdentityForParts({
    name: source.name,
    title: source.title,
    artist: source.artist,
    mediaType: source.mediaType,
  });
}

export function contentIdentityForName(
  input: ContentIdentityInput,
): ContentIdentity {
  return contentIdentityForParts({
    name: input.name,
    mediaType: input.mediaType,
  });
}

function contentIdentityForParts(input: {
  name: string;
  mediaType: LibraryMediaType;
  title?: string | null;
  artist?: string | null;
}): ContentIdentity {
  const metadataTitle = sanitizePart(input.title);
  const metadataArtist = sanitizePart(input.artist);
  if (metadataTitle !== null) {
    return buildIdentity(input.mediaType, metadataTitle, metadataArtist);
  }

  const base = stripExtension(input.name).trim();
  const parsed = parseArtistTitle(base);
  const title = parsed.title || base || input.name;
  const artist = parsed.artist;
  return buildIdentity(input.mediaType, title, artist);
}

function buildIdentity(
  mediaType: LibraryMediaType,
  title: string,
  artist: string | null,
): ContentIdentity {
  const titleToken = toToken(title);
  const artistToken = artist === null ? '' : toToken(artist);
  const key =
    artistToken === ''
      ? `${mediaType}:title:${titleToken}`
      : `${mediaType}:artist:${artistToken}:title:${titleToken}`;
  return {
    key,
    title,
    artist,
  };
}

function sanitizePart(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function contentKeyForLibraryItem(item: LibraryItem): string {
  return contentIdentityForLibraryItem(item).key;
}

export function contentKeyForPlaybackSource(source: PlaybackSource): string {
  return contentIdentityForPlaybackSource(source).key;
}

function stripExtension(name: string): string {
  const leaf = name.split(/[\\/]/).filter(Boolean).at(-1) ?? name;
  return leaf.replace(EXTENSION_RE, '');
}

function parseArtistTitle(base: string): {
  artist: string | null;
  title: string;
} {
  const match = base.match(/^(.+?)\s[-–—]\s(.+)$/);
  if (match === null) return { artist: null, title: base };
  const artist = match[1]?.trim() ?? '';
  const title = match[2]?.trim() ?? '';
  if (artist === '' || title === '') return { artist: null, title: base };
  return { artist, title };
}

function toToken(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-');
  return normalized || 'unknown';
}
