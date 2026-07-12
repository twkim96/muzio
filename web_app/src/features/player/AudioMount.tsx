import { useEffect, useRef } from 'react';

import { usePlayerStore } from './PlayerContext';

/**
 * Renders the hidden `<audio>` element that backs the global audio session.
 * Mounted once at the app root so audio playback survives route changes.
 *
 * Lifecycle: attach on mount, schedule a detach on cleanup that only fires
 * if the slot still points at this element after the current microtask.
 * React StrictMode's mount->cleanup->mount cycle replaces the wiring
 * synchronously inside the second mount, so by the time the deferred check
 * runs the slot has already been re-attached and the cleanup becomes a
 * no-op. A real unmount (which never happens for audio in practice today)
 * would let the deferred detach release the engine and avoid a detached
 * element holding the playback alive.
 */
export function AudioMount() {
  const store = usePlayerStore();
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    store.getState().attachElement('audio', element);
    const flushActivity = () => store.getState().flushActivity();
    window.addEventListener('pagehide', flushActivity);
    window.addEventListener('beforeunload', flushActivity);
    return () => {
      window.removeEventListener('pagehide', flushActivity);
      window.removeEventListener('beforeunload', flushActivity);
      queueMicrotask(() => {
        store.getState().detachElement('audio', element);
      });
    };
  }, [store]);

  return (
    <audio
      ref={ref}
      preload="metadata"
      data-testid="audio-mount"
      className="hidden"
    />
  );
}
