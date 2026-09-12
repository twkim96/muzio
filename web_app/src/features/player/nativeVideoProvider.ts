import { nativeFullscreenChange, nativeVideoFullscreenActive, setNativeVideoFullscreen } from './nativeVideoFullscreen';
import {
  TimeRange,
  AudioProviderLoader,
  TextTrack,
  type MediaContext,
  type MediaProviderAdapter,
  type MediaProviderLoader,
  type Src,
  type AudioTrackList,
} from '@vidstack/react';
import { androidShellBridge } from '../../core/platform/androidShell';
import type { NativeBridge } from '../../core/platform/nativeBridge';
import { decodeNativeVideoSource } from './nativeVideoSource';

export interface NativeVideoState {
  generation: string;
  ready: boolean;
  playing: boolean;
  ended: boolean;
  positionSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  rate: number;
  pip: boolean;
  pipSupported?: boolean;
  pipPossible?: boolean;
  waiting?: boolean;
  seeking?: boolean;
  buffered?: [number, number][];
  seekable?: [number, number][];
  error?: string;
  textTracks?: NativeVideoTrack[];
  audioTracks?: NativeVideoTrack[];
}

export interface NativeVideoTrack {
  id: string;
  label: string;
  language: string;
  selected: boolean;
}

type AudioListOperations = Record<'ADD' | 'REMOVE', symbol>;
const audioListOperations = new WeakMap<object, AudioListOperations>();

/** Production Vidstack strips symbol descriptions. Prove the mutation contract
 * on disposable lists, never by probing the user's tracks or symbol ordering. */
function resolveAudioListOperations(list: AudioTrackList): AudioListOperations {
  const prototype = Object.getPrototypeOf(list) as object;
  const cached = audioListOperations.get(prototype);
  if (cached) return cached;
  const List = list.constructor as new () => AudioTrackList;
  const symbols = new Set<symbol>();
  for (let owner: object | null = prototype; owner; owner = Object.getPrototypeOf(owner)) {
    for (const symbol of Object.getOwnPropertySymbols(owner)) {
      if (typeof Object.getOwnPropertyDescriptor(owner, symbol)?.value === 'function') symbols.add(symbol);
    }
  }
  const invoke = (probe: AudioTrackList, symbol: symbol, item: object) => {
    (probe as unknown as Record<symbol, (item: object) => void>)[symbol](item);
  };
  const sentinel = (id: string) => ({ id, label: id, language: '', kind: 'main' });
  const add = [...symbols].find(symbol => {
    try {
      const probe = new List();
      const item = sentinel('probe-add');
      invoke(probe, symbol, item);
      return probe.length === 1 && probe.toArray()[0] === item;
    } catch { return false; }
  });
  const remove = add === undefined ? undefined : [...symbols].find(symbol => {
    try {
      const probe = new List();
      const first = sentinel('probe-first'), second = sentinel('probe-second');
      invoke(probe, add, first);
      invoke(probe, add, second);
      invoke(probe, symbol, first);
      // A reset also removes the first track, but must never qualify as remove.
      return probe.length === 1 && probe.toArray()[0] === second;
    } catch { return false; }
  });
  if (add === undefined || remove === undefined) {
    throw new Error('Vidstack audio track compatibility failure: safe add/remove operations are unavailable');
  }
  const operations = { ADD: add, REMOVE: remove };
  audioListOperations.set(prototype, operations);
  return operations;
}

function mutateAudioList(list: AudioTrackList, operation: 'ADD' | 'REMOVE', item: object) {
  const symbol = resolveAudioListOperations(list)[operation];
  (list as unknown as Record<symbol, (item: object) => void>)[symbol](item);
}

function nativeVideoBridge(): NativeBridge | null {
  const bridge = androidShellBridge() as NativeBridge | null;
  return (bridge?.platform === 'ios' || bridge?.platform === 'macos') &&
    bridge.capabilities?.nativeVideo === true &&
    typeof bridge.subscribe === 'function' ? bridge : null;
}

export function supportsNativeVideo() { return nativeVideoBridge() !== null; }

let nextGeneration = 0;

/** Adapts the native playback engine while retaining Vidstack's state and layout. */
export class NativeVideoProvider implements MediaProviderAdapter {
  readonly type = 'muzio-native-video';
  currentSrc: Src | null = null;
  readonly scope: MediaProviderAdapter['scope'];
  private generation = '';
  private state: NativeVideoState | null = null;
  private unsubscribe: (() => void) | null = null;
  private destroyed = false;
  private removeFullscreenListeners: (() => void) | null = null;
  private ready = false;
  private syncingTracks = false;
  private nativeTextTracks = new Map<string, TextTrack>();
  private removeTrackListeners: (() => void) | null = null;
  private nativeAudioIds = new Set<string>();

  constructor(
    private readonly context: MediaContext,
    private readonly bridge: NativeBridge,
    scope: MediaProviderAdapter['scope'],
  ) { this.scope = scope; }

  readonly fullscreen = {
    get active() { return nativeVideoFullscreenActive(this.owner.context.player.el); },
    supported: true,
    owner: this,
    enter: async () => {
      if (!setNativeVideoFullscreen(this.context.player.el, true)) throw new Error('Video surface is not ready');
    },
    exit: async () => { setNativeVideoFullscreen(this.context.player.el, false); },
  };

  readonly pictureInPicture = {
    get active() { return this.owner.state?.pip === true; },
    get supported() { return this.owner.state?.pipSupported === true; },
    owner: this,
    enter: async () => { await this.command('pip', { active: true }); },
    exit: async () => { await this.command('pip', { active: false }); },
  };

  setup() {
    const element = this.context.player?.el;
    if (element) {
      const onChange = (event: Event) => this.context.notify('fullscreen-change', (event as CustomEvent<boolean>).detail);
      const onRequest = (event: Event) => {
        event.preventDefault(); event.stopImmediatePropagation();
        const operation = event.type === 'media-enter-fullscreen-request' ? this.fullscreen.enter() : this.fullscreen.exit();
        void operation.catch(error => this.context.notify('fullscreen-error', error));
      };
      // Keep the native pixels and WK controls in the same host, including
      // fullscreen requests from the stock button, keyboard and double tap.
      element.addEventListener(nativeFullscreenChange, onChange);
      element.addEventListener('media-enter-fullscreen-request', onRequest, true);
      element.addEventListener('media-exit-fullscreen-request', onRequest, true);
      this.removeFullscreenListeners = () => {
        element.removeEventListener(nativeFullscreenChange, onChange);
        element.removeEventListener('media-enter-fullscreen-request', onRequest, true);
        element.removeEventListener('media-exit-fullscreen-request', onRequest, true);
      };
    }
    const onTextModeChange = () => {
      if (this.syncingTracks || this.destroyed) return;
      const selected = this.context.textTracks.selected;
      this.send('tracks', { textId: selected && this.nativeTextTracks.has(selected.id) ? selected.id : null });
    };
    this.context.textTracks.addEventListener('mode-change', onTextModeChange);
    const onAudioChange = () => {
      if (this.syncingTracks || this.destroyed) return;
      const selected = this.context.audioTracks.selected;
      if (selected && this.nativeAudioIds.has(selected.id)) this.send('tracks', { audioId: selected.id });
    };
    this.context.audioTracks.addEventListener('change', onAudioChange);
    this.removeTrackListeners = () => {
      this.context.textTracks.removeEventListener('mode-change', onTextModeChange);
      this.context.audioTracks.removeEventListener('change', onAudioChange);
    };
    this.unsubscribe = this.bridge.subscribe((event) => {
      if (event.type === 'video') this.receive(event.state as NativeVideoState);
    });
    this.context.notify('provider-setup', this);
  }

  async loadSource(src: Src) {
    this.currentSrc = src;
    this.generation = `native-video-${Date.now()}-${++nextGeneration}`;
    this.ready = false;
    this.syncTextTracks([]);
    this.syncAudioTracks([]);
    this.state = null;
    this.context.notify('load-start');
    const generation = this.generation;
    try { await this.command('load', { title: this.context.$state?.title?.() ?? 'Video', url: typeof src.src === 'string' ? decodeNativeVideoSource(src.src) : src.src }); }
    catch (error) {
      if (generation !== this.generation || this.destroyed) return;
      this.reportError(error); throw error;
    }
  }

  async play() { await this.command('play'); }
  async pause() { await this.command('pause'); }
  setMuted(muted: boolean) { this.send('settings', { muted }); }
  setVolume(volume: number) { this.send('settings', { volume }); }
  setPlaybackRate(rate: number) { this.send('settings', { rate }); }
  setPlaysInline() {}
  setCurrentTime(time: number) {
    this.context.notify('seeking', time);
    const generation = this.generation;
    void this.command('seek', { positionSec: time }).catch((error) => {
      if (generation === this.generation) this.reportError(error);
    });
  }

  destroy() {
    setNativeVideoFullscreen(this.context.player?.el ?? null, false);
    this.removeFullscreenListeners?.(); this.removeFullscreenListeners = null;
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.removeTrackListeners?.();
    this.syncTextTracks([]);
    this.syncAudioTracks([]);
    // Native checks the generation so a delayed cleanup cannot stop a new item.
    void this.command('clear').catch(() => {});
  }

  private command(command: string, payload: object = {}) {
    return this.bridge.request(`video.${command}`, { ...payload, generation: this.generation });
  }

  private send(command: string, payload: object) {
    const generation = this.generation;
    void this.command(command, payload).catch((error) => {
      if (generation === this.generation) this.reportError(error);
    });
  }

  private reportError(error: unknown) {
    if (!this.destroyed) this.context.notify('error', {
      code: 1, message: error instanceof Error ? error.message : String(error),
    });
  }

  private syncTextTracks(tracks: NativeVideoTrack[]) {
    this.syncingTracks = true;
    try {
      const ids = new Set(tracks.map(track => track.id));
      for (const [id, track] of this.nativeTextTracks) {
        if (!ids.has(id)) {
          this.context.textTracks.remove(track);
          this.nativeTextTracks.delete(id);
        }
      }
      for (const info of tracks) {
        let track = this.nativeTextTracks.get(info.id);
        if (!track) {
          // Cues are rendered by the native video engine; Vidstack owns menu
          // selection. No web cue renderer or second subtitle download is needed.
          track = new TextTrack({ id: info.id, label: info.label, language: info.language, kind: 'subtitles' });
          this.nativeTextTracks.set(info.id, track);
          this.context.textTracks.add(track);
        }
        track.setMode(info.selected ? 'showing' : 'disabled');
      }
    } finally { this.syncingTracks = false; }
  }

  private syncAudioTracks(tracks: NativeVideoTrack[]) {
    this.syncingTracks = true;
    try {
      const ids = new Set(tracks.map(track => track.id));
      for (const id of this.nativeAudioIds) {
        const track = this.context.audioTracks.getById(id);
        if (!ids.has(id) && track) mutateAudioList(this.context.audioTracks, 'REMOVE', track);
      }
      this.nativeAudioIds = ids;
      for (const info of tracks) {
        if (!this.context.audioTracks.getById(info.id)) {
          mutateAudioList(this.context.audioTracks, 'ADD', {
            id: info.id, label: info.label, language: info.language, kind: 'main',
          });
        }
      }
      for (const info of tracks) {
        const track = this.context.audioTracks.getById(info.id);
        if (track) track.selected = info.selected;
      }
    } finally { this.syncingTracks = false; }
  }

  /** Every native message is scoped to one load, including late seek/PiP callbacks. */
  private receive(state: NativeVideoState) {
    if (this.destroyed || !state || state.generation !== this.generation) return;
    const previous = this.state;
    this.state = state;
    if (state.error) { this.reportError(state.error); return; }
    try {
      if (state.textTracks) this.syncTextTracks(state.textTracks);
      if (state.audioTracks) this.syncAudioTracks(state.audioTracks);
    } catch (error) {
      // Surface an actionable player error instead of leaving an unexplained spinner.
      this.reportError(error);
      return;
    }
    const duration = Number.isFinite(state.durationSec) ? Math.max(0, state.durationSec) : 0;
    const buffered = new TimeRange(state.buffered ?? []);
    const seekable = new TimeRange(state.seekable ?? (duration > 0 ? [[0, duration]] : []));
    if (state.ready && !this.ready) {
      this.ready = true;
      this.context.notify('loaded-metadata');
      this.context.notify('loaded-data');
      void this.context.delegate.ready({ duration, buffered, seekable });
    } else if (state.ready && duration !== previous?.durationSec) {
      this.context.notify('duration-change', duration);
    }
    if (state.ready) {
      this.context.notify('progress', { buffered, seekable });
      this.context.notify('time-change', state.positionSec);
    }
    if (state.seeking && !previous?.seeking) this.context.notify('seeking', state.positionSec);
    if (state.seeking === false && previous?.seeking) {
      this.context.notify('seeked', state.positionSec);
    }
    if (state.playing !== previous?.playing) {
      if (state.playing) {
        this.context.notify('play');
        if (!state.waiting) this.context.notify('playing');
      // The initial paused loading snapshot is not a playback transition:
      // emitting pause here cancels the engine's pending play before readiness.
      } else if (previous?.playing) this.context.notify('pause');
    } else if (previous?.waiting && !state.waiting && state.playing) {
      this.context.notify('playing');
    }
    if (state.waiting && !previous?.waiting) this.context.notify('waiting');
    if (state.volume !== previous?.volume || state.muted !== previous?.muted) {
      this.context.notify('volume-change', { volume: state.volume, muted: state.muted });
    }
    if (state.rate !== previous?.rate) this.context.notify('rate-change', state.rate);
    if (state.pip !== previous?.pip) this.context.notify('picture-in-picture-change', state.pip);
    if (state.ended && !previous?.ended) this.context.notify('end');
  }
}

export class NativeVideoProviderLoader implements MediaProviderLoader<NativeVideoProvider> {
  readonly name = 'muzio-native-video';
  target: HTMLElement | null = null;
  canPlay(src: Src) { return supportsNativeVideo() && typeof src.src === 'string'; }
  mediaType() { return 'video' as const; }
  async load(context: MediaContext) {
    const bridge = nativeVideoBridge();
    if (!bridge || !(this.target instanceof HTMLVideoElement)) {
      throw new Error('Native video host is unavailable');
    }
    // The React package keeps its reactive scope factory private. Its public loader
    // supplies an isolated scope using the same runtime. The HTML provider is never
    // set up or loaded: the outlet is only a transparent geometry placeholder.
    const loader = new AudioProviderLoader();
    loader.target = document.createElement('audio');
    const placeholder = await loader.load(context);
    return new NativeVideoProvider(context, bridge, placeholder.scope);
  }
}

export const nativeVideoLoaders = [NativeVideoProviderLoader];
