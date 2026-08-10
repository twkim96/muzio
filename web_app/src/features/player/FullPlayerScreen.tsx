import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  fetchFallbackPlan,
} from '../../core/api/fallbackClient';
import { contentKeyForPlaybackSource } from '../../core/media/contentIdentity';
import { canPlayMime } from '../../core/playback/capabilities/canPlayMime';
import { explicitNextQueueIndex, previousQueueIndex } from './musicQueue';
import { usePlayerStore } from './PlayerContext';
import { QueueDrawer } from './QueueDrawer';
import { selectActiveState, type SleepTimerState } from './playerStore';
import { PositionScrubber } from './controls/PositionScrubber';
import { TimeDisplay } from './controls/TimeDisplay';
import { useDocumentHorizontalDrag } from './controls/useDocumentHorizontalDrag';
import { formatTime } from './formatTime';
import { usePlaybackNetworkHint } from './playbackNetworkStatus';
import {
  DownChevronIcon,
  LikeGlyph,
  MoreGlyph,
  MusicGlyph,
  PauseGlyph,
  PlayGlyph,
  QueueGlyph,
  RepeatGlyph,
  RepeatOneGlyph,
  ShuffleGlyph,
  SkipGlyph,
  SleepTimerGlyph,
  StopAfterCurrentGlyph,
  VolumeGlyph,
} from '../../core/ui/AppIcons';
import { describePlaybackStatus } from './playerMessage';
import { useDismissGesture } from './useDismissGesture';
import { usePlayerKeyboardControls } from './usePlayerKeyboardControls';
import {
  FallbackStatusView,
  VideoWatchScreen,
  type VideoFallbackState,
} from './VideoWatchScreen';

type FallbackState = VideoFallbackState;

type PopoverKind = 'timer' | 'volume' | null;

/**
 * Full-screen player. Reads the active session and switches between the
 * music and video presentations based on the loaded source's mediaType.
 *
 * The branch is driven by `snapshot.active` rather than the loaded source so
 * a video click that arrives before Vidstack has loaded still renders the
 * video surface; engine attachment drains the queued source and starts
 * playback once the provider is ready.
 */
export function FullPlayerScreen({
  onCollapse,
}: {
  onCollapse?: () => void;
} = {}) {
  const navigate = useNavigate();
  const store = usePlayerStore();
  const snapshot = store();
  const state = selectActiveState(snapshot);
  const active = snapshot.active;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const actionShellRef = useRef<HTMLDivElement | null>(null);
  const [fallbackState, setFallbackState] = useState<FallbackState>({
    kind: 'idle',
  });
  const [openPopover, setOpenPopover] = useState<PopoverKind>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [customMinutes, setCustomMinutes] = useState('45');
  usePlayerKeyboardControls(shellRef, active !== 'video');
  const retryActivePlayback = store((s) => s.retryActivePlayback);
  const source = state.source;
  const networkHint = usePlaybackNetworkHint(state.status, source);

  const playability =
    state.source?.mimeType !== undefined
      ? canPlayMime(state.source.mimeType)
      : 'maybe';
  const sourceId = state.source?.mediaId ?? null;

  useEffect(() => {
    if (sourceId === null || playability !== 'no') {
      setFallbackState({ kind: 'idle' });
      return;
    }

    const controller = new AbortController();
    setFallbackState({ kind: 'loading' });
    void fetchFallbackPlan(sourceId, 'no', { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.kind === 'ok') {
          setFallbackState({ kind: 'ok', plan: result.plan });
          return;
        }
        setFallbackState({ kind: 'error' });
      },
    );

    return () => controller.abort();
  }, [playability, sourceId]);

  useEffect(() => {
    if (openPopover === null) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (actionShellRef.current?.contains(target)) return;
      setOpenPopover(null);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [openPopover]);

  const isVideo = active === 'video';
  const collapseTarget = isVideo ? '/library/video' : '/library/music';
  const collapsePlayer = () => {
    if (onCollapse !== undefined) {
      onCollapse();
      return;
    }
    navigate(collapseTarget);
  };
  const dismissGesture = useDismissGesture({ onDismiss: collapsePlayer });

  if (active === null) {
    return (
      <div className="mx-auto max-w-xl p-6 text-center">
        <h1 className="mb-2 text-2xl font-semibold">Player</h1>
        <p className="text-muted">Nothing is playing.</p>
        <Link
          to="/"
          className="mt-4 inline-block text-sm text-muted underline"
        >
          Back home
        </Link>
      </div>
    );
  }

  const banner = describePlaybackStatus(state.status);
  const sourceName = source?.name ?? 'Loading...';
  const sourceDetail =
    source?.artist ??
    source?.rootName ??
    source?.relativePath ??
    (isVideo ? 'Video' : 'Music');
  const isInFlight =
    state.status.kind === 'playing' ||
    state.status.kind === 'buffering' ||
    state.status.kind === 'loading';
  const playLabel = isInFlight ? 'Pause' : 'Play';
  const currentLikeKey =
    source === null ? '' : contentKeyForPlaybackSource(source);
  const liked =
    source !== null &&
    (snapshot.likedMediaIds.includes(currentLikeKey) ||
      snapshot.likedMediaIds.includes(source.mediaId));
  const queueSnapshot = {
    tracks: snapshot.musicQueue,
    currentIndex: snapshot.musicQueueIndex,
    repeatMode: snapshot.repeatMode,
    stopAfterCurrent: snapshot.stopAfterCurrent,
  };
  const canPlayPrevious =
    !isVideo && previousQueueIndex(queueSnapshot) !== null;
  const canPlayNext =
    !isVideo && explicitNextQueueIndex(queueSnapshot) !== null;
  if (isVideo) {
    return (
      <VideoWatchScreen
        shellRef={shellRef}
        source={source}
        sourceName={sourceName}
        sourceDetail={sourceDetail}
        positionSec={state.positionSec}
        durationSec={state.durationSec}
        playability={playability}
        fallbackState={fallbackState}
        onCollapse={collapsePlayer}
      />
    );
  }

  return (
    <div
      ref={shellRef}
      data-testid="player-screen"
      className="relative min-h-screen touch-pan-x overflow-hidden overscroll-y-contain bg-transparent text-foreground"
      {...dismissGesture.bind}
    >
      <div
        data-testid="player-motion-layer"
        className={`relative z-10 min-h-screen overflow-hidden bg-surface ${dismissGesture.motionClassName}`}
        style={dismissGesture.motionStyle}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgba(174,174,174,0.14),transparent_34%),linear-gradient(135deg,rgba(255,55,85,0.16),transparent_28%),linear-gradient(215deg,rgba(90,120,96,0.28),transparent_42%)]" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/22 via-transparent to-black/30" />
        <DismissButton label="Collapse music player" onCollapse={collapsePlayer} />

        <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-start px-6 py-10 [--player-art-width:min(26rem,38vh,78vw)] sm:justify-center sm:px-10 sm:py-10 sm:[--player-art-width:min(34rem,48vh,78vw)]">
          <NowPlayingArtwork artworkUrl={source?.artworkUrl} />

          <section className="mx-auto mt-5 w-full max-w-3xl">
            <div className="mx-auto w-[var(--player-art-width)]">
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  {sourceName}
                </h1>
                <p className="truncate text-lg text-white/65 sm:text-xl">
                  {sourceDetail}
                </p>
              </div>
            </div>

            <div
              ref={actionShellRef}
              className="relative mx-auto mt-4 w-[var(--player-art-width)]"
            >
              <div
                data-testid="player-action-rail"
                data-no-dismiss-gesture
                className="grid w-full grid-cols-6 items-center gap-1 overflow-visible px-0.5 sm:gap-2"
              >
                <ActionButton
                  label={liked ? 'Unlike current track' : 'Like current track'}
                  active={liked}
                  disabled={currentLikeKey === ''}
                  testId="like-current"
                  onClick={() => snapshot.toggleLike(currentLikeKey)}
                >
                  <LikeGlyph liked={liked} />
                </ActionButton>
                <ActionButton
                  label="Sleep timer"
                  active={
                    openPopover === 'timer' ||
                    snapshot.sleepTimer.kind === 'running'
                  }
                  expanded={openPopover === 'timer'}
                  onClick={() =>
                    setOpenPopover((current) =>
                      current === 'timer' ? null : 'timer',
                    )
                  }
                >
                  <SleepTimerGlyph />
                </ActionButton>
                <ActionButton
                  label="Volume"
                  active={
                    openPopover === 'volume' ||
                    snapshot.muted ||
                    snapshot.volume < 0.99
                  }
                  expanded={openPopover === 'volume'}
                  onClick={() =>
                    setOpenPopover((current) =>
                      current === 'volume' ? null : 'volume',
                    )
                  }
                >
                  <VolumeGlyph muted={snapshot.muted} />
                </ActionButton>
                <ActionButton
                  label="Open queue"
                  active={queueOpen}
                  expanded={queueOpen}
                  onClick={() => setQueueOpen(true)}
                >
                  <QueueGlyph />
                </ActionButton>
                <ActionButton label="More actions" disabled>
                  <MoreGlyph />
                </ActionButton>
                <ActionButton
                  label="Stop after current"
                  active={snapshot.stopAfterCurrent}
                  testId="stop-after-current"
                  onClick={snapshot.toggleStopAfterCurrent}
                >
                  <StopAfterCurrentGlyph />
                </ActionButton>
              </div>
            {openPopover === 'timer' && (
              <ActionPopoverPanel>
                <SleepTimerPopover
                  customMinutes={customMinutes}
                  sleepTimer={snapshot.sleepTimer}
                  onCancel={snapshot.cancelSleepTimer}
                  onCustomMinutes={setCustomMinutes}
                  onStart={snapshot.startSleepTimer}
                />
              </ActionPopoverPanel>
            )}
            {openPopover === 'volume' && (
              <ActionPopoverPanel>
                <VolumePopover
                  muted={snapshot.muted}
                  volume={snapshot.volume}
                  onMute={snapshot.toggleMute}
                  onVolume={snapshot.setVolume}
                />
              </ActionPopoverPanel>
            )}
            </div>

          {playability === 'no' && (
            <p
              data-testid="unsupported-banner"
              className="mx-auto mt-4 w-[min(26rem,38vh,78vw)] text-sm text-amber-200 sm:w-[min(34rem,48vh,78vw)]"
            >
              The browser reports that this format may not play. Direct play
              will still be attempted.
            </p>
          )}
          {playability === 'no' && (
            <FallbackStatusView fallbackState={fallbackState} />
          )}

          <div className="mx-auto mt-4 w-[min(26rem,38vh,78vw)] sm:w-[min(34rem,48vh,78vw)]">
            <PositionScrubber
              positionSec={state.positionSec}
              durationSec={state.durationSec}
            />
            <div className="mt-2 grid min-h-5 grid-cols-[minmax(0,1fr)_6rem] items-center text-sm tabular-nums text-white/65">
              <TimeDisplay
                positionSec={state.positionSec}
                durationSec={state.durationSec}
              />
              <span
                data-testid="full-status"
                aria-hidden={banner === '' ? true : undefined}
                className={`text-right ${banner === '' ? 'invisible' : ''}`}
              >
                {banner || 'Status'}
              </span>
            </div>
            {networkHint !== null && (
              <div
                data-testid="full-network-hint"
                role="status"
                className="mt-2 flex min-h-8 items-center justify-between gap-2 rounded-xl border border-white/15 bg-zinc-950/72 px-2.5 py-1.5 text-sm text-white shadow-sm shadow-black/15 backdrop-blur max-sm:flex-col max-sm:items-stretch"
              >
                <span className="min-w-0 truncate">{networkHint.message}</span>
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-white/15 px-2 py-0.5 text-xs font-semibold text-white hover:bg-white/10 max-sm:self-start"
                  onClick={() => {
                    void retryActivePlayback();
                  }}
                >
                  {networkHint.retryLabel}
                </button>
              </div>
            )}
          </div>

            <div
              data-testid="transport-controls"
              className="mx-auto mt-5 flex w-[min(26rem,38vh,78vw)] items-center justify-between sm:w-[min(34rem,48vh,78vw)]"
            >
            <TransportButton
              label="Shuffle"
              active={snapshot.shuffle}
              testId="shuffle-toggle"
              onClick={snapshot.toggleShuffle}
            >
              <ShuffleGlyph className="h-5 w-5 sm:h-6 sm:w-6" />
            </TransportButton>
            <TransportButton
              label="Previous"
              disabled={!canPlayPrevious}
              size="skip"
              onClick={() => {
                void snapshot.playPreviousQueueItem();
              }}
            >
              <SkipGlyph direction="back" className="h-7 w-7 sm:h-8 sm:w-8" />
            </TransportButton>
            <button
              type="button"
              data-testid="play-pause"
              data-status={state.status.kind}
              aria-label={playLabel}
              className="inline-flex h-16 w-16 items-center justify-center text-white drop-shadow-[0_10px_24px_rgba(0,0,0,0.28)] transition hover:scale-[1.03] hover:text-white/90 disabled:opacity-50 sm:h-20 sm:w-20"
              onClick={() => {
                void snapshot.togglePlayPause();
              }}
            >
              {isInFlight ? (
                <PauseGlyph className="h-[3.75rem] w-[3.75rem] sm:h-[4.5rem] sm:w-[4.5rem]" />
              ) : (
                <PlayGlyph className="h-[3.75rem] w-[3.75rem] sm:h-[4.5rem] sm:w-[4.5rem]" />
              )}
            </button>
            <TransportButton
              label="Next"
              disabled={!canPlayNext}
              size="skip"
              onClick={() => {
                void snapshot.playNextQueueItem();
              }}
            >
              <SkipGlyph direction="forward" className="h-7 w-7 sm:h-8 sm:w-8" />
            </TransportButton>
            <TransportButton
              label={repeatLabel(snapshot.repeatMode)}
              active={snapshot.repeatMode !== 'none'}
              testId="repeat-toggle"
              onClick={snapshot.cycleRepeatMode}
            >
              {snapshot.repeatMode === 'one' ? (
                <RepeatOneGlyph className="h-5 w-5 sm:h-6 sm:w-6" />
              ) : (
                <RepeatGlyph className="h-5 w-5 sm:h-6 sm:w-6" />
              )}
            </TransportButton>
            </div>

          </section>
        </main>
      </div>
      <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
    </div>
  );
}

function NowPlayingArtwork({ artworkUrl }: { artworkUrl?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [artworkUrl]);
  return (
    <div
      data-testid="now-playing-art"
      className="mx-auto flex aspect-square w-[var(--player-art-width)] items-center justify-center overflow-hidden rounded-2xl bg-zinc-200/80 text-7xl text-muted shadow-2xl shadow-black/20 dark:bg-white/[0.08]"
      aria-hidden
    >
      {artworkUrl && !failed ? (
        <img
          data-testid="now-playing-art-image"
          src={artworkUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <MusicGlyph className="h-16 w-16" />
      )}
    </div>
  );
}

function DismissButton({
  label,
  onCollapse,
}: {
  label: string;
  onCollapse: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="player-close"
      aria-label={label}
      className="absolute left-4 top-4 z-20 inline-flex h-11 w-11 items-center justify-center rounded-full text-white/88 transition hover:bg-white/10 hover:text-white sm:left-6 sm:top-6"
      onClick={onCollapse}
    >
      <DownChevronIcon />
    </button>
  );
}

function ActionButton({
  label,
  active = false,
  expanded,
  disabled = false,
  testId,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  testId?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={disabled ? undefined : active}
      aria-expanded={expanded}
      data-testid={testId}
      disabled={disabled}
      className="inline-flex h-10 min-w-0 items-center justify-center rounded-full text-xl leading-none text-white/72 transition hover:bg-white/[0.055] hover:text-white aria-pressed:bg-accent/15 aria-pressed:text-accent aria-pressed:ring-1 aria-pressed:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-35 sm:h-12 sm:text-2xl"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ActionPopoverPanel({ children }: { children: ReactNode }) {
  return (
    <div
      data-glass
      className="absolute left-1/2 top-16 z-30 w-[min(20rem,86vw)] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/24 bg-[#111113] p-4 text-left text-white shadow-2xl shadow-black/90 backdrop-blur-[96px] [-webkit-backdrop-filter:saturate(1.55)_blur(96px)] [backdrop-filter:saturate(1.55)_blur(96px)]"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_25%_20%,rgba(255,255,255,0.18),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.10),rgba(255,255,255,0.025))] opacity-90 blur-3xl"
      />
      <div className="relative">{children}</div>
    </div>
  );
}

function TransportButton({
  label,
  active = false,
  disabled = false,
  size = 'default',
  testId,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  size?: 'default' | 'skip';
  testId?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={disabled ? undefined : active}
      data-testid={testId}
      disabled={disabled}
      className={
        size === 'skip'
          ? 'inline-flex h-12 w-12 items-center justify-center rounded-xl text-white/64 transition hover:bg-white/[0.055] hover:text-white disabled:cursor-not-allowed disabled:opacity-45 sm:h-14 sm:w-14'
          : 'inline-flex h-10 w-10 items-center justify-center rounded-xl text-3xl leading-none text-white/56 transition hover:bg-white/[0.055] hover:text-white aria-pressed:bg-accent/15 aria-pressed:text-accent aria-pressed:ring-1 aria-pressed:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-45 sm:h-12 sm:w-12 sm:text-4xl'
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function VolumePopover({
  muted,
  volume,
  onMute,
  onVolume,
}: {
  muted: boolean;
  volume: number;
  onMute: () => void;
  onVolume: (volume: number) => void;
}) {
  const sliderRef = useRef<HTMLInputElement | null>(null);
  const draggingRef = useRef(false);
  const dragTracking = useDocumentHorizontalDrag();

  const valueFromClientX = (clientX: number) => {
    const slider = sliderRef.current;
    if (slider === null || !Number.isFinite(clientX)) return volume;
    const rect = slider.getBoundingClientRect();
    if (rect.width <= 0) return volume;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  };
  const updateVolume = (nextVolume: number) => {
    if (!Number.isFinite(nextVolume)) return;
    onVolume(Math.min(Math.max(nextVolume, 0), 1));
  };
  const beginTracking = () => {
    draggingRef.current = true;
    dragTracking.start({
      onMove: (clientX) => {
        if (draggingRef.current) {
          updateVolume(valueFromClientX(clientX));
        }
      },
      onEnd: (clientX) =>
        endTracking(
          clientX === undefined ? undefined : valueFromClientX(clientX),
        ),
    });
  };
  const endTracking = (nextVolume?: number) => {
    if (!draggingRef.current) return;
    if (Number.isFinite(nextVolume)) {
      updateVolume(nextVolume as number);
    }
    draggingRef.current = false;
    dragTracking.stop();
  };

  return (
    <section
      data-testid="volume-control"
      aria-label="Volume"
      className="flex items-center gap-3"
    >
      <button
        type="button"
        data-testid="mute-toggle"
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg leading-none text-white/80 hover:bg-white/10 aria-pressed:text-accent sm:h-9 sm:w-9"
        onClick={onMute}
      >
        <VolumeGlyph muted={muted} className="h-5 w-5" />
      </button>
      <input
        ref={sliderRef}
        type="range"
        data-testid="volume-slider"
        data-no-dismiss-gesture
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(event) => onVolume(Number(event.target.value))}
        onMouseDown={beginTracking}
        onMouseMove={(event) => {
          if (draggingRef.current) {
            updateVolume(valueFromClientX(event.clientX));
          }
        }}
        onMouseUp={(event) => endTracking(valueFromClientX(event.clientX))}
        onPointerCancel={(event) =>
          endTracking(Number(event.currentTarget.value))
        }
        onPointerDown={(event) => {
          beginTracking();
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) {
            updateVolume(valueFromClientX(event.clientX));
          }
        }}
        onPointerUp={(event) => endTracking(valueFromClientX(event.clientX))}
        onTouchCancel={(event) => endTracking(Number(event.currentTarget.value))}
        onTouchEnd={(event) => endTracking(Number(event.currentTarget.value))}
        onTouchStart={beginTracking}
        aria-label="Volume"
        className="min-w-0 flex-1 touch-none accent-accent"
      />
      <span className="w-9 text-right text-xs tabular-nums text-white/55">
        {Math.round(volume * 100)}%
      </span>
    </section>
  );
}

function SleepTimerPopover({
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
            className="rounded-full border border-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/10"
            onClick={() => onStart(minutes)}
          >
            {minutes}m
          </button>
        ))}
        <button
          type="button"
          className="rounded-full border border-white/15 px-3 py-1.5 text-xs font-semibold hover:bg-white/10"
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
          className="rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-white/80"
          onClick={applyCustom}
        >
          Set
        </button>
      </div>
    </section>
  );
}

function repeatLabel(mode: 'none' | 'all' | 'one'): string {
  if (mode === 'all') return 'Repeat all';
  if (mode === 'one') return 'Repeat one';
  return 'Repeat off';
}
