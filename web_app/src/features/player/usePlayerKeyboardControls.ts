import { useEffect, type RefObject } from 'react';

import { usePlayerStore } from './PlayerContext';
import { selectActiveState } from './playerStore';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

async function toggleFullscreen(element: HTMLElement | null) {
  if (element === null) return;
  const doc = element.ownerDocument;
  if (doc.fullscreenElement !== null) {
    await doc.exitFullscreen?.();
    return;
  }
  await element.requestFullscreen?.();
}

export function usePlayerKeyboardControls(
  containerRef: RefObject<HTMLElement>,
  enabled = true,
) {
  const store = usePlayerStore();

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      const snapshot = store.getState();
      const state = selectActiveState(snapshot);
      if (state.source === null) return;

      if (event.key === ' ' || event.key.toLowerCase() === 'k') {
        event.preventDefault();
        void snapshot.togglePlayPause();
        return;
      }

      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'j') {
        event.preventDefault();
        snapshot.seekActive(Math.max(0, state.positionSec - 10));
        return;
      }

      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'l') {
        event.preventDefault();
        const upper =
          state.durationSec > 0
            ? Math.min(state.durationSec, state.positionSec + 10)
            : state.positionSec + 10;
        snapshot.seekActive(upper);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        snapshot.setVolume(snapshot.volume + 0.05);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        snapshot.setVolume(snapshot.volume - 0.05);
        return;
      }

      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        snapshot.toggleMute();
        return;
      }

      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        void toggleFullscreen(containerRef.current);
        return;
      }

      if (event.key === 'Escape') {
        const doc = containerRef.current?.ownerDocument;
        if (doc?.fullscreenElement) {
          event.preventDefault();
          void doc.exitFullscreen?.();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, enabled, store]);
}
