import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { explicitNextQueueIndex, previousQueueIndex } from './musicQueue';
import { usePlayerStore } from './PlayerContext';
import { usePlayerOverlay } from './PlayerOverlayContext';
import { QueueDrawer } from './QueueDrawer';
import { selectActiveState, type SleepTimerState } from './playerStore';
import { describePlaybackStatus } from './playerMessage';
import { usePlaybackNetworkHint } from './playbackNetworkStatus';
import { formatTime } from './formatTime';
import { useDocumentHorizontalDrag } from './controls/useDocumentHorizontalDrag';
import {
  MusicGlyph,
  PauseGlyph,
  PlayGlyph,
  QueueGlyph,
  RepeatGlyph,
  RepeatOneGlyph,
  ShuffleGlyph,
  SkipGlyph,
  SleepTimerGlyph,
  VideoGlyph,
  VolumeGlyph,
} from '../../core/ui/AppIcons';

/**
 * Persistent bottom bar shown whenever any session has a source loaded.
 * The bar tracks whichever session is active so the surface looks the same
 * for music and for video (with the full video frame living in the overlay).
 */
export function MiniPlayer() {
  const { open } = usePlayerOverlay();
  const store = usePlayerStore();
  const snapshot = store();
  const state = selectActiveState(snapshot);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [scrubValueSec, setScrubValueSec] = useState<number | null>(null);
  const [scrubPreviewSec, setScrubPreviewSec] = useState<number | null>(null);
  const [customMinutes, setCustomMinutes] = useState('45');
  const timerShellRef = useRef<HTMLDivElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const scrubPreviewHideRef = useRef<number | null>(null);
  const scrubValueRef = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const scrubTracking = useDocumentHorizontalDrag();
  const sleepTimer = store((s) => s.sleepTimer);
  const togglePlayPause = store((s) => s.togglePlayPause);
  const toggleShuffle = store((s) => s.toggleShuffle);
  const cycleRepeatMode = store((s) => s.cycleRepeatMode);
  const toggleMute = store((s) => s.toggleMute);
  const setVolume = store((s) => s.setVolume);
  const seekActive = store((s) => s.seekActive);
  const retryActivePlayback = store((s) => s.retryActivePlayback);
  const networkHint = usePlaybackNetworkHint(state.status, state.source);

  useEffect(() => {
    if (!timerOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (timerShellRef.current?.contains(target)) return;
      setTimerOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [timerOpen]);

  useEffect(() => {
    return () => {
      if (scrubPreviewHideRef.current !== null) {
        window.clearTimeout(scrubPreviewHideRef.current);
      }
    };
  }, []);

  if (state.source === null) return null;

  const banner = describePlaybackStatus(state.status);
  const durationIsKnown =
    Number.isFinite(state.durationSec) && state.durationSec > 0;
  const positionValue =
    durationIsKnown && Number.isFinite(state.positionSec)
      ? Math.min(Math.max(state.positionSec, 0), state.durationSec)
      : 0;
  const displayedPositionValue = scrubValueSec ?? positionValue;
  const timerLabel =
    sleepTimer.kind === 'running'
      ? `${formatTime(sleepTimer.remainingSec)} left`
      : sleepTimer.kind === 'expired'
        ? 'Timer paused'
        : '';
  const isInFlight =
    state.status.kind === 'playing' ||
    state.status.kind === 'buffering' ||
    state.status.kind === 'loading';
  const playLabel = isInFlight ? 'Pause' : 'Play';
  const repeatLabel =
    snapshot.repeatMode === 'one'
      ? 'Repeat one'
      : snapshot.repeatMode === 'all'
        ? 'Repeat all'
        : 'Repeat off';
  const queueSnapshot = {
    tracks: snapshot.musicQueue,
    currentIndex: snapshot.musicQueueIndex,
    repeatMode: snapshot.repeatMode,
    stopAfterCurrent: snapshot.stopAfterCurrent,
  };
  const canPlayPrevious =
    state.source.mediaType === 'audio' && previousQueueIndex(queueSnapshot) !== null;
  const canPlayNext =
    state.source.mediaType === 'audio' && explicitNextQueueIndex(queueSnapshot) !== null;
  const handleVolumeChange = (value: number) => {
    if (snapshot.muted) toggleMute();
    setVolume(value);
  };
  const clearScrubPreviewHide = () => {
    if (scrubPreviewHideRef.current !== null) {
      window.clearTimeout(scrubPreviewHideRef.current);
      scrubPreviewHideRef.current = null;
    }
  };
  const valueFromScrubberClientX = (clientX: number) => {
    if (!durationIsKnown) return displayedPositionValue;
    if (!Number.isFinite(clientX)) return displayedPositionValue;
    const scrubber = scrubberRef.current;
    if (scrubber === null) return displayedPositionValue;
    const rect = scrubber.getBoundingClientRect();
    if (rect.width <= 0) return displayedPositionValue;
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    return ratio * state.durationSec;
  };
  const canStartScrubAt = (clientX: number) => {
    if (!durationIsKnown || !Number.isFinite(clientX)) return false;
    const scrubber = scrubberRef.current;
    if (scrubber === null) return false;
    const rect = scrubber.getBoundingClientRect();
    if (rect.width <= 0) return false;
    const playedX = rect.left + (positionValue / state.durationSec) * rect.width;
    const tolerance = 16;
    return clientX >= rect.left - tolerance && clientX <= playedX + tolerance;
  };
  const hideScrubPreviewSoon = () => {
    clearScrubPreviewHide();
    scrubPreviewHideRef.current = window.setTimeout(() => {
      setScrubPreviewSec(null);
      scrubPreviewHideRef.current = null;
    }, 900);
  };
  const showScrubPreview = (value: number, autoHide = true) => {
    if (!durationIsKnown) return;
    const clamped = Math.min(Math.max(value, 0), state.durationSec);
    setScrubPreviewSec(clamped);
    if (autoHide) {
      hideScrubPreviewSoon();
    } else {
      clearScrubPreviewHide();
    }
  };
  const handleSeek = (value: number) => {
    if (!durationIsKnown) return;
    const clamped = Math.min(Math.max(value, 0), state.durationSec);
    scrubValueRef.current = clamped;
    setScrubValueSec(clamped);
    showScrubPreview(clamped, !scrubbingRef.current);
    if (!scrubbingRef.current) {
      seekActive(clamped);
    }
  };
  const beginScrubbing = (clientX: number) => {
    if (!canStartScrubAt(clientX)) return;
    scrubbingRef.current = true;
    scrubValueRef.current = positionValue;
    setScrubValueSec(positionValue);
    showScrubPreview(positionValue, false);
    scrubTracking.start({
      onMove: (nextClientX) => {
        if (scrubbingRef.current) {
          handleSeek(valueFromScrubberClientX(nextClientX));
        }
      },
      onEnd: (nextClientX) =>
        finishScrubbing(
          nextClientX === undefined
            ? undefined
            : valueFromScrubberClientX(nextClientX),
        ),
    });
  };
  const finishScrubbing = (finalInputValue?: number) => {
    if (!scrubbingRef.current) return;
    const fallbackValue = scrubValueRef.current ?? positionValue;
    const finalValue =
      Number.isFinite(finalInputValue) && durationIsKnown
        ? Math.min(Math.max(finalInputValue as number, 0), state.durationSec)
        : fallbackValue;
    scrubbingRef.current = false;
    scrubTracking.stop();
    scrubValueRef.current = null;
    setScrubValueSec(null);
    seekActive(finalValue);
    showScrubPreview(finalValue, false);
    hideScrubPreviewSoon();
  };
  return (
    <div
      data-testid="mini-player"
      data-glass
      data-no-menu-swipe
      className="fixed inset-x-0 bottom-0 z-40 px-3 pb-3 sm:px-6 lg:left-[var(--app-sidebar-width)]"
    >
      <div className="mx-auto grid max-w-4xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-full border border-zinc-200/35 bg-surface/88 px-4 py-3 shadow-2xl shadow-black/10 backdrop-blur-xl dark:border-white/[0.045] dark:shadow-black/35 max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:rounded-2xl">
        <div className="flex items-center gap-1.5 max-sm:hidden">
          <MiniIconButton
            label="Shuffle"
            active={snapshot.shuffle}
            onClick={toggleShuffle}
          >
            <ShuffleGlyph className="h-4 w-4" />
          </MiniIconButton>
          <MiniIconButton
            label="Previous"
            disabled={!canPlayPrevious}
            variant="skip"
            onClick={() => {
              void snapshot.playPreviousQueueItem();
            }}
          >
            <SkipGlyph direction="back" className="h-6 w-6" />
          </MiniIconButton>
          <button
            type="button"
            data-testid="play-pause"
            data-status={state.status.kind}
            aria-label={playLabel}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-zinc-950 transition hover:scale-[1.03] hover:bg-zinc-200/60 disabled:opacity-50 dark:text-white dark:hover:bg-white/[0.06]"
            onClick={() => {
              void togglePlayPause();
            }}
          >
            {isInFlight ? (
              <PauseGlyph className="h-8 w-8" />
            ) : (
              <PlayGlyph className="h-8 w-8" />
            )}
          </button>
          <MiniIconButton
            label="Next"
            disabled={!canPlayNext}
            variant="skip"
            onClick={() => {
              void snapshot.playNextQueueItem();
            }}
          >
            <SkipGlyph direction="forward" className="h-6 w-6" />
          </MiniIconButton>
          <MiniIconButton label={repeatLabel} active={snapshot.repeatMode !== 'none'} onClick={cycleRepeatMode}>
            {snapshot.repeatMode === 'one' ? (
              <RepeatOneGlyph className="h-4 w-4" />
            ) : (
              <RepeatGlyph className="h-4 w-4" />
            )}
          </MiniIconButton>
        </div>

        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
          <button
            type="button"
            aria-label="Open full player"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-200/80 text-lg text-muted shadow-sm hover:ring-2 hover:ring-accent/55 dark:bg-white/[0.08]"
            data-testid="open-full-player"
            onClick={open}
          >
            {state.source.mediaType === 'video' ? (
              <VideoGlyph className="h-6 w-6" />
            ) : (
              <MusicGlyph className="h-6 w-6" />
            )}
          </button>
          <span className="min-w-0" data-testid="mini-player-details">
            <span className="block truncate text-sm font-semibold text-zinc-950 dark:text-foreground">
              {state.source.name}
            </span>
            <span
              data-testid="mini-player-time"
              className="block truncate text-xs tabular-nums text-muted"
            >
              {formatTime(displayedPositionValue)} : {formatTime(state.durationSec)}
            </span>
            <div
              ref={scrubberRef}
              data-testid="mini-scrubber"
              data-no-menu-swipe
              role="slider"
              aria-valuemin={0}
              aria-valuemax={durationIsKnown ? state.durationSec : 1}
              aria-valuenow={displayedPositionValue}
              aria-disabled={!durationIsKnown}
              aria-label="Mini player seek"
              className={`mt-1 flex h-2.5 w-full touch-none items-center ${
                durationIsKnown ? '' : 'opacity-50'
              }`}
              onMouseDown={(event) => beginScrubbing(event.clientX)}
              onMouseMove={(event) => {
                if (scrubbingRef.current) {
                  handleSeek(valueFromScrubberClientX(event.clientX));
                }
              }}
              onMouseUp={(event) =>
                finishScrubbing(valueFromScrubberClientX(event.clientX))
              }
              onPointerCancel={(event) => finishScrubbing(event.clientX)}
              onPointerDown={(event) => {
                beginScrubbing(event.clientX);
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (scrubbingRef.current) {
                  handleSeek(valueFromScrubberClientX(event.clientX));
                }
              }}
              onPointerUp={(event) =>
                finishScrubbing(valueFromScrubberClientX(event.clientX))
              }
              onTouchCancel={() => finishScrubbing()}
              onTouchEnd={(event) => {
                const touch = event.changedTouches[0] ?? event.touches[0];
                finishScrubbing(
                  touch === undefined
                    ? undefined
                    : valueFromScrubberClientX(touch.clientX),
                );
              }}
              onTouchStart={(event) => {
                const touch = event.touches[0];
                if (touch) beginScrubbing(touch.clientX);
              }}
            >
              <span className="relative block h-1 w-full rounded-full bg-zinc-300/70 dark:bg-white/12">
                <span
                  className="absolute left-0 top-0 h-full rounded-full bg-white/80 dark:bg-white"
                  style={{
                    width: `${
                      durationIsKnown
                        ? (displayedPositionValue / state.durationSec) * 100
                        : 0
                    }%`,
                  }}
                />
                <span
                  className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow shadow-black/20"
                  style={{
                    left: `${
                      durationIsKnown
                        ? (displayedPositionValue / state.durationSec) * 100
                        : 0
                    }%`,
                  }}
                />
              </span>
            </div>
            {networkHint !== null && (
              <div
                data-testid="mini-network-hint"
                role="status"
                className="mt-1 flex min-h-5 items-center gap-2 text-xs text-muted"
              >
                <span className="min-w-0 truncate">{networkHint.message}</span>
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-white/12 px-2 py-0.5 text-xs font-medium text-zinc-950 hover:bg-zinc-200/70 dark:text-white dark:hover:bg-white/10"
                  onClick={() => {
                    void retryActivePlayback();
                  }}
                >
                  {networkHint.retryLabel}
                </button>
              </div>
            )}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {banner !== '' && (
            <span
              data-testid="mini-status"
              className="hidden text-xs text-muted xl:inline"
            >
              {banner}
            </span>
          )}
          {timerLabel !== '' && (
            <span
              data-testid="mini-sleep-timer"
              className="hidden text-xs tabular-nums text-muted sm:inline"
            >
              {timerLabel}
            </span>
          )}
          <button
            type="button"
            aria-label="Open queue"
            data-testid="mini-queue-button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-xl leading-none text-muted hover:bg-zinc-200/70 hover:text-zinc-950 dark:hover:bg-white/10 dark:hover:text-foreground"
            onClick={() => setQueueOpen(true)}
          >
            <QueueGlyph className="h-6 w-6" />
          </button>
          <div className="relative" ref={timerShellRef}>
            <button
              type="button"
              aria-label="Sleep timer"
              aria-expanded={timerOpen}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-zinc-200/70 hover:text-zinc-950 dark:hover:bg-white/10 dark:hover:text-foreground"
              onClick={() => setTimerOpen((open) => !open)}
            >
              <SleepTimerGlyph className="h-7 w-7" />
            </button>
            {timerOpen && (
              <div
                data-testid="mini-timer-popover"
                data-glass
                data-allow-scroll
                className="fixed bottom-[7.25rem] left-1/2 z-[70] max-h-[min(22rem,calc(100vh-9rem))] w-[min(21rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/24 bg-[#111113] p-3 text-white shadow-2xl shadow-black/90 backdrop-blur-[96px] [-webkit-backdrop-filter:saturate(1.55)_blur(96px)] [backdrop-filter:saturate(1.55)_blur(96px)]"
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_25%_20%,rgba(255,255,255,0.18),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.10),rgba(255,255,255,0.025))] opacity-90 blur-3xl"
                />
                <div className="relative max-h-[calc(min(22rem,100vh-9rem)-1.5rem)] overflow-y-auto">
                  <MiniTimerPopover
                    customMinutes={customMinutes}
                    sleepTimer={sleepTimer}
                    onCancel={snapshot.cancelSleepTimer}
                    onCustomMinutes={setCustomMinutes}
                    onStart={snapshot.startSleepTimer}
                  />
                </div>
              </div>
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              aria-label="Volume"
              aria-expanded={volumeOpen}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full text-2xl leading-none text-muted hover:bg-zinc-200/70 hover:text-zinc-950 dark:hover:bg-white/10 dark:hover:text-foreground"
              onClick={() => setVolumeOpen((open) => !open)}
            >
              <VolumeGlyph muted={snapshot.muted} className="h-6 w-6" />
            </button>
            {volumeOpen && (
              <div
                data-testid="mini-volume-popover"
                className="absolute bottom-11 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1.5 rounded-xl border border-zinc-200/60 bg-surface/92 px-2 py-2 shadow-2xl shadow-black/20 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/86"
              >
                <input
                  type="range"
                  data-testid="mini-volume-slider"
                  min={0}
                  max={1}
                  step={0.05}
                  value={snapshot.volume}
                  aria-label="Mini player volume"
                  className="h-20 w-6 accent-accent"
                  style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                  onChange={(event) =>
                    handleVolumeChange(Number(event.target.value))
                  }
                />
                <span className="text-[0.7rem] tabular-nums text-muted">
                  {Math.round(snapshot.volume * 100)}%
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            data-status={state.status.kind}
            aria-label={playLabel}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-zinc-950 hover:bg-zinc-200/60 dark:text-white dark:hover:bg-white/[0.06] sm:hidden"
            onClick={() => {
              void togglePlayPause();
            }}
          >
            {isInFlight ? (
              <PauseGlyph className="h-7 w-7" />
            ) : (
              <PlayGlyph className="h-7 w-7" />
            )}
          </button>
        </div>
      </div>
      {scrubPreviewSec !== null && durationIsKnown && (
        <div
          data-testid="mini-scrub-preview"
          data-glass
          className="pointer-events-none fixed left-1/2 top-1/2 z-[80] flex h-24 min-w-40 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-2 rounded-2xl border border-white/15 bg-zinc-950/78 px-5 text-lg font-semibold tabular-nums text-white shadow-2xl shadow-black/35 backdrop-blur-[34px]"
        >
          <span>{formatTime(scrubPreviewSec)}</span>
          <span className="text-white/55">/</span>
          <span>{formatTime(state.durationSec)}</span>
        </div>
      )}
      <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
    </div>
  );
}

function MiniIconButton({
  label,
  active = false,
  disabled = false,
  variant = 'utility',
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  variant?: 'utility' | 'skip';
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={disabled ? undefined : active}
      disabled={disabled}
      className={
        variant === 'skip'
          ? 'inline-flex h-10 w-10 items-center justify-center rounded-xl text-zinc-800 hover:bg-zinc-200/55 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-70 dark:text-white dark:hover:bg-white/[0.06] dark:hover:text-white'
          : 'inline-flex h-10 w-10 items-center justify-center rounded-xl text-2xl leading-none text-muted hover:bg-zinc-200/55 hover:text-zinc-950 aria-pressed:bg-accent/12 aria-pressed:text-accent aria-pressed:ring-1 aria-pressed:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-white/[0.06] dark:hover:text-foreground'
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MiniTimerPopover({
  customMinutes,
  sleepTimer,
  onCancel,
  onCustomMinutes,
  onStart,
}: {
  customMinutes: string;
  sleepTimer: SleepTimerState;
  onCancel: () => void;
  onCustomMinutes: (value: string) => void;
  onStart: (minutes: number) => void;
}) {
  const applyCustom = () => {
    const minutes = Number(customMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    onStart(minutes);
  };

  return (
    <section data-testid="sleep-timer-control" aria-label="Sleep timer">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Sleep timer</h2>
        <span
          data-testid="sleep-timer-status"
          className="text-xs tabular-nums text-white/60"
        >
          {sleepTimer.kind === 'running'
            ? formatTime(sleepTimer.remainingSec)
            : sleepTimer.kind === 'expired'
              ? 'Paused'
              : 'Off'}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {[15, 30, 60].map((minutes) => (
          <button
            key={minutes}
            type="button"
            className="rounded-full border border-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/12"
            onClick={() => onStart(minutes)}
          >
            {minutes}m
          </button>
        ))}
        <button
          type="button"
          className="rounded-full border border-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/12"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="number"
          min={1}
          step={1}
          value={customMinutes}
          onChange={(event) => onCustomMinutes(event.target.value)}
          aria-label="Custom timer minutes"
          className="w-20 rounded-full border border-white/15 bg-transparent px-3 py-1 text-sm"
        />
        <button
          type="button"
          className="rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-white/85"
          onClick={applyCustom}
        >
          Set
        </button>
      </div>
    </section>
  );
}
