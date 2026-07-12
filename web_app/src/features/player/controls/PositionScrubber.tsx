import { useEffect, useRef, useState } from 'react';

import { usePlayerStore } from '../PlayerContext';
import { formatTime } from '../formatTime';
import { useDocumentHorizontalDrag } from './useDocumentHorizontalDrag';

interface Props {
  positionSec: number;
  durationSec: number;
  disabled?: boolean;
}

/**
 * Plain HTML range input wired to the active session. Browsers already give
 * us drag, keyboard, and accessibility behavior for free; we only own the
 * value <-> seek bridge.
 */
export function PositionScrubber({ positionSec, durationSec, disabled }: Props) {
  const store = usePlayerStore();
  const seek = store((s) => s.seekActive);
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const [previewValue, setPreviewValue] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrubbingRef = useRef(false);
  const scrubValueRef = useRef<number | null>(null);
  const previewHideRef = useRef<number | null>(null);
  const scrubReleaseRef = useRef<number | null>(null);
  const dragTracking = useDocumentHorizontalDrag();

  useEffect(() => {
    return () => {
      if (previewHideRef.current !== null) {
        window.clearTimeout(previewHideRef.current);
      }
      if (scrubReleaseRef.current !== null) {
        window.clearTimeout(scrubReleaseRef.current);
      }
    };
  }, []);

  const max = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const value = Number.isFinite(positionSec) && positionSec >= 0 ? positionSec : 0;
  const effectivelyDisabled = disabled === true || max === 0;
  const displayedValue = scrubValue ?? Math.min(value, max || 0);
  const valueFromClientX = (clientX: number) => {
    const input = inputRef.current;
    if (!Number.isFinite(clientX)) {
      return scrubValueRef.current ?? displayedValue;
    }
    if (input === null || max === 0) return displayedValue;
    const rect = input.getBoundingClientRect();
    if (rect.width <= 0) return displayedValue;
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    return ratio * max;
  };
  const clearPreviewHide = () => {
    if (previewHideRef.current !== null) {
      window.clearTimeout(previewHideRef.current);
      previewHideRef.current = null;
    }
  };
  const hidePreviewSoon = () => {
    clearPreviewHide();
    previewHideRef.current = window.setTimeout(() => {
      setPreviewValue(null);
      previewHideRef.current = null;
    }, 900);
  };
  const clampValue = (nextValue: number) =>
    Math.min(Math.max(nextValue, 0), max);
  const showPreview = (nextValue: number, autoHide = true) => {
    if (effectivelyDisabled) return;
    setPreviewValue(clampValue(nextValue));
    if (autoHide) {
      hidePreviewSoon();
    } else {
      clearPreviewHide();
    }
  };
  const beginScrubbing = () => {
    if (effectivelyDisabled) return;
    if (scrubReleaseRef.current !== null) {
      window.clearTimeout(scrubReleaseRef.current);
      scrubReleaseRef.current = null;
    }
    scrubbingRef.current = true;
    scrubValueRef.current = displayedValue;
    setScrubValue(displayedValue);
    showPreview(displayedValue, false);
    dragTracking.start({
      onMove: (clientX) => updateScrubValue(valueFromClientX(clientX)),
      onEnd: (clientX) =>
        finishScrubbing(
          clientX === undefined ? undefined : valueFromClientX(clientX),
        ),
    });
  };
  const updateScrubValue = (nextValue: number) => {
    if (effectivelyDisabled) return;
    const clamped = clampValue(nextValue);
    scrubValueRef.current = clamped;
    setScrubValue(clamped);
    showPreview(clamped, !scrubbingRef.current);
    if (!scrubbingRef.current) {
      seek(clamped);
    }
  };
  const finishScrubbing = (currentInputValue?: number) => {
    if (!scrubbingRef.current) return;
    const finalValue = clampValue(
      Number.isFinite(currentInputValue)
        ? (currentInputValue as number)
        : (scrubValueRef.current ?? displayedValue),
    );
    scrubbingRef.current = false;
    dragTracking.stop();
    scrubValueRef.current = null;
    setScrubValue(finalValue);
    seek(finalValue);
    showPreview(finalValue, false);
    hidePreviewSoon();
    scrubReleaseRef.current = window.setTimeout(() => {
      if (!scrubbingRef.current) {
        setScrubValue(null);
      }
      scrubReleaseRef.current = null;
    }, 250);
  };
  return (
    <>
      <input
        ref={inputRef}
        type="range"
        data-testid="scrubber"
        data-no-dismiss-gesture
        data-no-menu-swipe
        min={0}
        max={max || 1}
        step={0.1}
        value={displayedValue}
        disabled={effectivelyDisabled}
        onChange={(event) => updateScrubValue(Number(event.target.value))}
        onMouseDown={beginScrubbing}
        onMouseMove={(event) => {
          if (scrubbingRef.current) updateScrubValue(valueFromClientX(event.clientX));
        }}
        onMouseUp={(event) => finishScrubbing(valueFromClientX(event.clientX))}
        onPointerCancel={(event) => finishScrubbing(Number(event.currentTarget.value))}
        onPointerDown={(event) => {
          beginScrubbing();
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (scrubbingRef.current) updateScrubValue(valueFromClientX(event.clientX));
        }}
        onPointerUp={(event) => finishScrubbing(valueFromClientX(event.clientX))}
        onTouchCancel={(event) => finishScrubbing(Number(event.currentTarget.value))}
        onTouchEnd={(event) => finishScrubbing(Number(event.currentTarget.value))}
        onTouchStart={beginScrubbing}
        aria-label="Seek"
        className="w-full touch-none accent-accent disabled:opacity-50"
      />
      {previewValue !== null && !effectivelyDisabled && (
        <div
          data-testid="full-scrub-preview"
          data-glass
          className="pointer-events-none fixed left-1/2 top-1/2 z-[80] flex h-24 min-w-40 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-2 rounded-2xl border border-white/15 bg-zinc-950/78 px-5 text-lg font-semibold tabular-nums text-white shadow-2xl shadow-black/35 backdrop-blur-[34px]"
        >
          <span>{formatTime(previewValue)}</span>
          <span className="text-white/55">/</span>
          <span>{formatTime(durationSec)}</span>
        </div>
      )}
    </>
  );
}
