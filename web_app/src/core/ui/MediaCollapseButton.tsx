import { useEffect, useState } from 'react';

import { DownChevronIcon } from './AppIcons';

function isFullscreen() {
  return Boolean(document.fullscreenElement ||
    (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement);
}

export function MediaCollapseButton({ label, onCollapse, testId = 'player-close' }: {
  label: string;
  onCollapse: () => void;
  testId?: string;
}) {
  const [fullscreen, setFullscreen] = useState(isFullscreen);
  useEffect(() => {
    const update = () => setFullscreen(isFullscreen());
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
    };
  }, []);

  if (fullscreen) return null;
  return (
    <button
      type="button"
      data-testid={testId}
      data-glass
      data-no-dismiss-gesture
      aria-label={label}
      onClick={onCollapse}
      className="muzio-settings-button muzio-media-collapse fixed z-30 flex h-[46.4px] w-[46.4px] items-center justify-center text-foreground"
    >
      <DownChevronIcon className="h-[21.1px] w-[21.1px]" />
    </button>
  );
}
