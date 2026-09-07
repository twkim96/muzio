import { androidShellBridge } from './androidShell';

/** Keeps the same DOM video alive while Android crops the Activity to its PiP window. */
export function connectAndroidVideoPip(root: HTMLElement) {
  const bridge = androidShellBridge();
  if (!bridge) return () => {};
  let pip = false;
  let placeholder: Comment | null = null;
  let previousStyle: string | null = null;
  const style = document.createElement('style');
  style.textContent = `html[data-muzio-pip], body[data-muzio-pip] { background: black !important; overflow: hidden !important; }
    body[data-muzio-pip] > * { visibility: hidden !important; }
    body[data-muzio-pip] > [data-muzio-pip-video], body[data-muzio-pip] > [data-muzio-pip-video] * { visibility: visible !important; }
    body[data-muzio-pip] [data-muzio-pip-video] .vds-controls, body[data-muzio-pip] [data-muzio-pip-video] .vds-gesture { display: none !important; }
    body[data-muzio-pip] [data-muzio-pip-video] [data-media-player] { border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }`;
  const video = () => root.querySelector('video');
  const report = () => {
    const current = video();
    void bridge.request('shell.videoState', {
      playing: !!current && !current.paused && !current.ended && current.readyState >= 2,
      width: current?.videoWidth || 16, height: current?.videoHeight || 9,
    }).catch(() => {});
  };
  const sizeSurface = () => {
    if (!pip) return;
    // Android can retain page scale < 1 during PiP resize: 100vw describes
    // the smaller layout viewport, leaving part of the visual viewport blank.
    const viewport = window.visualViewport;
    root.style.setProperty('width', `${viewport?.width ?? window.innerWidth}px`, 'important');
    root.style.setProperty('height', `${viewport?.height ?? window.innerHeight}px`, 'important');
  };
  const setPip = (enabled: boolean) => {
    if (enabled === pip) return;
    pip = enabled;
    if (enabled) {
      placeholder = document.createComment('video-pip-home');
      root.before(placeholder);
      previousStyle = root.getAttribute('style');
      document.head.append(style);
      document.documentElement.dataset.muzioPip = '';
      document.body.dataset.muzioPip = '';
      root.dataset.muzioPipVideo = '';
      document.body.append(root);
      root.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;opacity:1!important;overflow:hidden!important;z-index:2147483647!important;background:black!important;';
      sizeSurface();
    } else {
      placeholder?.replaceWith(root);
      placeholder = null;
      if (previousStyle === null) root.removeAttribute('style'); else root.setAttribute('style', previousStyle);
      delete root.dataset.muzioPipVideo;
      delete document.documentElement.dataset.muzioPip;
      delete document.body.dataset.muzioPip;
      style.remove();
    }
  };
  const onPip = (event: Event) => setPip((event as CustomEvent<boolean>).detail === true);
  const onStop = () => video()?.pause();
  const onControl = (event: Event) => {
    if (!pip) return;
    const current = video();
    if (!current) return;
    const command = (event as CustomEvent<string>).detail;
    // Explicit commands are idempotent: a stale Play action must not toggle
    // an already playing video off. Media events also update the player store.
    if (command === 'pause') {
      current.pause();
      report();
    } else if (command === 'play') {
      void current.play().then(report, report);
    }
  };
  const events = ['playing', 'play', 'pause', 'ended', 'loadedmetadata', 'emptied', 'canplay'];
  events.forEach((event) => root.addEventListener(event, report, true));
  window.addEventListener('resize', sizeSurface);
  window.visualViewport?.addEventListener('resize', sizeSurface);
  window.addEventListener('muzio-pip', onPip);
  window.addEventListener('muzio-video-stop', onStop);
  window.addEventListener('muzio-video-control', onControl);
  report();
  return () => {
    setPip(false);
    events.forEach((event) => root.removeEventListener(event, report, true));
    window.removeEventListener('resize', sizeSurface);
    window.visualViewport?.removeEventListener('resize', sizeSurface);
    window.removeEventListener('muzio-pip', onPip);
    window.removeEventListener('muzio-video-stop', onStop);
    window.removeEventListener('muzio-video-control', onControl);
    void bridge.request('shell.videoState', { playing: false }).catch(() => {});
  };
}
