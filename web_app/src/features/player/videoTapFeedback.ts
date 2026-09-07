/** Show feedback only after a surface gesture's requested state is acknowledged. */
export function connectVideoTapFeedback(root: HTMLElement, show: (action: 'play' | 'pause' | null) => void) {
  let pending: 'play' | 'pause' | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timeout); pending = null; show(null); };
  const gesture = (event: Event) => {
    if ((event as CustomEvent).detail !== 'toggle:paused') return;
    clear();
    pending = root.hasAttribute('data-paused') ? 'play' : 'pause';
    timeout = setTimeout(clear, 2000);
  };
  const acknowledge = (event: Event) => {
    if (event.type !== pending) return;
    clearTimeout(timeout);
    show(pending);
    pending = null;
    timeout = setTimeout(clear, 650);
  };
  root.addEventListener('will-trigger', gesture, true);
  root.addEventListener('play', acknowledge);
  root.addEventListener('pause', acknowledge);
  root.addEventListener('source-change', clear);
  return () => {
    clear();
    root.removeEventListener('will-trigger', gesture, true);
    root.removeEventListener('play', acknowledge);
    root.removeEventListener('pause', acknowledge);
    root.removeEventListener('source-change', clear);
  };
}
