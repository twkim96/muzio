import { nativeFullscreenChange, registerNativeVideoFullscreen } from './nativeVideoFullscreen';
import { registerAndroidBack, androidShellBridge } from '../../core/platform/androidShell';

/** The WK page stays above the native video surface, so menus, captions and controls retain
 * their normal DOM stacking and touch handling. Only the video background clears. */
export function connectNativeVideoSurface(root: HTMLElement) {
  const bridge = androidShellBridge();
  if ((bridge?.platform !== 'ios' && bridge?.platform !== 'macos') || !bridge.capabilities?.nativeVideo) return () => {};
  const style = document.createElement('style');
  style.textContent = `[data-native-video-clear], [data-native-video-clear]::backdrop { background: transparent !important; }
    [data-native-video-clear] .vds-gesture[action='toggle:paused'] { display: block !important; }
    [data-native-video-clear] .vds-gesture[action='toggle:controls'] { display: none !important; }
    [data-native-video-expanded] { position: fixed !important; inset: 0 !important; width: 100% !important; height: 100% !important; z-index: 2147483646 !important; }
    [data-native-video-expanded] [data-media-player] { border: 0 !important; border-radius: 0 !important; }
    [data-native-video-covered] { opacity: 0 !important; pointer-events: none !important; }`;
  document.head.append(style);
  let cleared: HTMLElement[] = [], covered: HTMLElement[] = [];
  const clipped = new Map<HTMLElement, string>();
  let last = '', previousHost: HTMLElement | null = null, previousFullscreen: Element | null = null;
  let frame = 0;
  let fullscreen = false;
  let placeholder: Comment | null = null;
  let homeScreen: HTMLElement | null = null;
  let unregisterFullscreen: (() => void) | undefined;
  let unregisterBack: (() => void) | undefined;
  let registeredPlayer: HTMLElement | null = null;
  const setFullscreen = (active: boolean) => {
    if (fullscreen === active) return;
    if (active) {
      homeScreen = root.closest<HTMLElement>('[data-testid="player-screen"]');
      if (!homeScreen) return;
      placeholder = document.createComment('native-video-inline-home');
      root.before(placeholder);
      fullscreen = true;
      root.dataset.nativeVideoExpanded = '';
      document.body.append(root);
      unregisterBack = registerAndroidBack(() => setFullscreen(false), 100);
    } else {
      fullscreen = false;
      delete root.dataset.nativeVideoExpanded;
      if (root.parentElement === document.body) placeholder?.replaceWith(root);
      else placeholder?.remove();
      placeholder = null; homeScreen = null;
      unregisterBack?.(); unregisterBack = undefined;
    }
    registeredPlayer?.dispatchEvent(new CustomEvent(nativeFullscreenChange, { detail: fullscreen }));
    void bridge.request('video.fullscreen', { active: fullscreen }).catch(() => {});
    // Rebuild transparency/occlusion after either direction of the move.
    previousHost = null;
  };
  const unsubscribeHost = bridge.subscribe?.(event => {
    if (event.type === 'videoFullscreen' && (event.state as { active?: boolean } | undefined)?.active === false) setFullscreen(false);
  });
  const onKey = (event: KeyboardEvent) => {
    if (fullscreen && event.key === 'Escape') { event.preventDefault(); setFullscreen(false); }
  };
  window.addEventListener('keydown', onKey);
  // The fullscreen surface leaves the original watch page's gesture ancestor.
  // Keep its downward exit gesture on the persistent surface itself.
  let swipeStart: { id: number; x: number; y: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    swipeStart = fullscreen && event.isPrimary !== false && event.button === 0 &&
      !(event.target instanceof Element && event.target.closest('button, input, [role="slider"], [role="menu"], .vds-controls, .vds-menu'))
      ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipeStart; swipeStart = null;
    if (!fullscreen || !start || start.id !== event.pointerId) return;
    const deltaY = event.clientY - start.y;
    if (deltaY < 80 || deltaY < Math.abs(event.clientX - start.x) * 1.5) return;
    event.preventDefault(); event.stopImmediatePropagation();
    setFullscreen(false);
  };
  const cancelSwipe = () => { swipeStart = null; };
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('pointerup', onPointerUp, true);
  root.addEventListener('pointercancel', cancelSwipe);


  const restore = () => {
    cleared.forEach(el => el.removeAttribute('data-native-video-clear'));
    covered.forEach(el => el.removeAttribute('data-native-video-covered'));
    cleared = []; covered = [];
    clipped.forEach((value, el) => { el.style.clipPath = value; }); clipped.clear();
  };
  const update = () => {
    const player = root.querySelector<HTMLElement>('[data-media-player]');
    if (player !== registeredPlayer) {
      unregisterFullscreen?.(); registeredPlayer = player;
      if (player) unregisterFullscreen = registerNativeVideoFullscreen(player, {
        get active() { return fullscreen; }, set: setFullscreen,
      });
    }
    if (fullscreen && (root.parentElement !== document.body || !placeholder?.isConnected)) setFullscreen(false);
    const screen = fullscreen ? homeScreen : root.closest<HTMLElement>('[data-testid="player-screen"]');
    const rect = player?.getBoundingClientRect();
    const visible = !!screen && !!rect && rect.width > 1 && rect.height > 1;
    if (previousFullscreen !== document.fullscreenElement || previousHost !== root.parentElement || (visible && cleared.length === 0) || (!visible && cleared.length > 0)) {
      restore(); previousHost = root.parentElement; previousFullscreen = document.fullscreenElement;
      if (visible && player && screen) {
        for (let element: HTMLElement | null = player; element; element = element.parentElement) {
          element.setAttribute('data-native-video-clear', ''); cleared.push(element);
        }
        // The full player used to obscure its underlying route with an opaque
        // page. Hide that route while the page background is transparent.
        for (let child: HTMLElement = fullscreen ? root : document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : screen; child.parentElement; child = child.parentElement) {
          for (const sibling of child.parentElement.children) {
            if (sibling !== child && sibling instanceof HTMLElement && !['STYLE', 'SCRIPT'].includes(sibling.tagName)) {
              sibling.setAttribute('data-native-video-covered', ''); covered.push(sibling);
            }
          }
        }
      }
    }
    // Scrolling content normally passes underneath the opaque sticky video.
    // Native pixels live below WK, so clip that content before it enters the hole.
    if (!fullscreen && visible && rect && screen) {
      for (const el of screen.querySelectorAll<HTMLElement>('[data-testid="video-info"], [data-testid="video-secondary-column"]')) {
        if (!clipped.has(el)) clipped.set(el, el.style.clipPath);
        const box = el.getBoundingClientRect();
        const overlap = box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
        el.style.clipPath = overlap ? `inset(${Math.max(0, rect.bottom - box.top)}px 0 0 0)` : (clipped.get(el) ?? '');
      }
    }
    const viewport = window.visualViewport;
    const scale = viewport?.scale ?? 1;
    const payload = {
      x: ((rect?.x ?? 0) - (viewport?.offsetLeft ?? 0)) * scale,
      y: ((rect?.y ?? 0) - (viewport?.offsetTop ?? 0)) * scale,
      width: (rect?.width ?? 0) * scale, height: (rect?.height ?? 0) * scale,
      viewportWidth: (viewport?.width ?? window.innerWidth) * scale,
      radius: player ? (parseFloat(getComputedStyle(player).borderTopLeftRadius) || 0) * scale : 0,
      visible,
    };
    const serialized = JSON.stringify(payload);
    if (last !== serialized) {
      last = serialized;
      void bridge.request('video.frame', payload).catch(() => {});
    }
    frame = requestAnimationFrame(update);
  };
  update();
  return () => {
    unsubscribeHost?.();
    cancelAnimationFrame(frame); setFullscreen(false);
    unregisterFullscreen?.(); window.removeEventListener('keydown', onKey);
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('pointerup', onPointerUp, true);
    root.removeEventListener('pointercancel', cancelSwipe);
    restore(); style.remove();
    void bridge.request('video.frame', { visible: false }).catch(() => {});
  };
}
