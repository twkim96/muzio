const prefix = 'muzio-native://source/';
const suffix = '/stream';

/** An opaque Vidstack identity prevents built-in loaders claiming native media. */
export function encodeNativeVideoSource(url: string): string {
  return `${prefix}${encodeURIComponent(url)}/stream`;
}

export function decodeNativeVideoSource(url: string): string {
  if (!url.startsWith(prefix) || !url.endsWith(suffix)) return url;
  try { return decodeURIComponent(url.slice(prefix.length, -suffix.length)); }
  catch { return url; }
}
