import { X } from '@phosphor-icons/react/dist/csr/X';
import { MusicGlyph, VideoGlyph, ImageGlyph } from '../core/ui/AppIcons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSearchPopoverHost } from './SearchHostContext';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';

export function FloatingSearchControl({
  onQueryChange,
  query,
  title,
  renderPreview,
  openRequest,
}: {
  onQueryChange: (query: string) => void;
  query: string;
  title: string;
  renderPreview?: (close: () => void) => ReactNode;
  openRequest?: string;
}) {
  const ScreenIcon = title === 'Video' ? VideoGlyph : title === 'Image' ? ImageGlyph : MusicGlyph;
  const popoverHost = useSearchPopoverHost();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const controlRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const popover = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`${title} search`}
      data-testid="search-popover"
      className="muzio-inline-search relative z-40 w-full"
    >
      <div className="flex h-[var(--menu-bar-height,50.6px)] items-center gap-2">
      <span className="muzio-search-screen-icon muzio-topbar flex h-[var(--menu-bar-height,50.6px)] w-[var(--menu-bar-height,50.6px)] shrink-0 items-center justify-center"><ScreenIcon aria-hidden className="h-6 w-6" /></span>
      <div className="muzio-search-field muzio-search flex h-[var(--menu-bar-height,50.6px)] min-w-0 flex-1 items-center gap-2 px-3">
      <MagnifyingGlass aria-hidden className="h-5 w-5 shrink-0 text-muted" weight="regular" />
      <input
        ref={inputRef}
        aria-label={`Filter ${title}`}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="검색어를 입력해주세요."
        className="min-w-0 flex-1 bg-transparent px-1 py-2 text-base outline-none placeholder:text-muted focus:text-zinc-950 dark:focus:text-foreground"
      />
      {query !== '' && (
        <button
          type="button"
          aria-label={`Clear filter ${title}`}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg text-muted hover:bg-zinc-200/70 dark:hover:bg-white/10"
          onClick={() => {
            onQueryChange('');
            inputRef.current?.focus();
          }}
        >
          ×
        </button>
      )}
      </div>
      <button type="button" aria-label={`Close ${title} search`} onClick={close} className="muzio-search-close muzio-topbar flex h-[var(--menu-bar-height,50.6px)] w-[var(--menu-bar-height,50.6px)] shrink-0 items-center justify-center"><X aria-hidden className="h-6 w-6" /></button>
      </div>
      {renderPreview && <div className="mt-2">{renderPreview(close)}</div>}
    </div>
  );

  return (
    <div ref={controlRef} className="flex items-center">
      <button
        ref={buttonRef}
        type="button"
        data-testid="search-toggle"
        aria-label={`Search ${title}`}
        aria-expanded={open}
        aria-pressed={query.trim() !== ''}
        data-active={query.trim() !== '' ? 'true' : 'false'}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground transition hover:bg-foreground/10 aria-pressed:text-accent"
        onClick={() => setOpen((current) => !current)}
      >
        <MagnifyingGlass aria-hidden className="h-6 w-6" weight="regular" />
      </button>
      {open && (popoverHost ? createPortal(popover, popoverHost) : popover)}
    </div>
  );
}
