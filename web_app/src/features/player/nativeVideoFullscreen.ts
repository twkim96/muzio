interface FullscreenSurface {
  active: boolean;
  set(active: boolean): void;
}
const surfaces = new WeakMap<HTMLElement, FullscreenSurface>();
export const nativeFullscreenChange = 'muzio-video-fullscreen-change';
export function registerNativeVideoFullscreen(player: HTMLElement, surface: FullscreenSurface) {
  surfaces.set(player, surface);
  return () => { if (surfaces.get(player) === surface) surfaces.delete(player); };
}
export function nativeVideoFullscreenActive(player: HTMLElement | null) {
  return !!player && surfaces.get(player)?.active === true;
}
export function setNativeVideoFullscreen(player: HTMLElement | null, active: boolean): boolean {
  const surface = player && surfaces.get(player);
  if (!surface) return false;
  surface.set(active);
  return true;
}
