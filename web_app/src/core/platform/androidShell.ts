import { useEffect, useRef } from 'react';

export interface AndroidShellBridge {
  request<T>(command: string, payload?: object): Promise<T>;
}
let shellBridge: AndroidShellBridge | null = null;
/** Configure once with the same bridge instance used by native audio. */
export function configureAndroidShell(bridge: AndroidShellBridge | null) { shellBridge = bridge; }
export function androidShellBridge() { return shellBridge; }

const migrationKeys = ['music.likes.v1', 'music.playlists.v1', 'music.activity.v1'] as const;
export async function migrateNativePreferences(bridge: AndroidShellBridge, storage: Storage = localStorage) {
  const { values } = await bridge.request<{ values: Record<string, string> }>('shell.legacyPreferences');
  for (const key of migrationKeys) {
    if (storage.getItem(key) === null && typeof values[key] === 'string') storage.setItem(key, values[key]);
  }
  await bridge.request('shell.finishMigration');
}

type BackHandler = { priority: number; handle: () => void };
const backHandlers: BackHandler[] = [];
function dispatchBack(event: Event) {
  if (event.defaultPrevented) return;
  const top = backHandlers.reduce<BackHandler | undefined>((best, next) =>
    !best || next.priority >= best.priority ? next : best, undefined);
  if (!top) return;
  event.preventDefault();
  top.handle();
}
/** Higher priority wins; the most recently opened surface wins ties. */
export function registerAndroidBack(handle: () => void, priority = 0) {
  const entry = { handle, priority };
  if (!backHandlers.length) window.addEventListener('muzio-back', dispatchBack);
  backHandlers.push(entry);
  return () => {
    const index = backHandlers.indexOf(entry);
    if (index >= 0) backHandlers.splice(index, 1);
    if (!backHandlers.length) window.removeEventListener('muzio-back', dispatchBack);
  };
}
export function useAndroidBack(active: boolean, handle: () => void, priority = 0) {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => active ? registerAndroidBack(() => latest.current(), priority) : undefined, [active, priority]);
}
