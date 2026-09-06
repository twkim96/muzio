import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchPopoverHost } from './SearchHostContext';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';

export function FloatingSearchControl({
  onQueryChange,
  query,
  title,
}: {
  onQueryChange: (query: string) => void;
  query: string;
  title: string;
}) {
  const popoverHost = useSearchPopoverHost();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const controlRef = useRef<HTMLDivElement | null>(null);

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
      className="muzio-search absolute left-1/2 top-[calc(100%+0.75rem)] z-40 flex h-[58px] w-[calc(100%+6rem)] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-3 px-5"
    >
      <MagnifyingGlass aria-hidden className="h-5 w-5 shrink-0 text-muted" weight="regular" />
      <input
        ref={inputRef}
        aria-label={`Filter ${title}`}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="검색"
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

