import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { useIncrementalVideoItems } from './useIncrementalVideoItems';

type ObserverCallback = IntersectionObserverCallback;

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  readonly observe = vi.fn<(target: Element) => void>();
  readonly disconnect = vi.fn<() => void>();
  readonly unobserve = vi.fn<(target: Element) => void>();

  private readonly callback: ObserverCallback;

  constructor(callback: ObserverCallback, options: IntersectionObserverInit = {}) {
    this.callback = callback;
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    this.thresholds = [0];
    TestIntersectionObserver.instances.push(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const originalIntersectionObserver = globalThis.IntersectionObserver;

function latestObserver(): TestIntersectionObserver {
  const observer = TestIntersectionObserver.instances.at(-1);
  if (observer === undefined) throw new Error('Expected an observer');
  return observer;
}

afterEach(() => {
  TestIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', originalIntersectionObserver);
  vi.restoreAllMocks();
});

describe('useIncrementalVideoItems', () => {
  test('renders 24 items, then loads one batch per intersection until exhausted', () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    const { result } = renderHook(() => useIncrementalVideoItems(60));
    const sentinel = document.createElement('button');
    act(() => result.current.sentinelRef(sentinel));

    expect(result.current.visibleCount).toBe(24);
    expect(result.current.hasMore).toBe(true);
    expect(latestObserver().root).toBeNull();
    expect(latestObserver().rootMargin).toBe('0px 0px 160px');
    expect(latestObserver().observe).toHaveBeenCalledWith(sentinel);

    const firstObserver = latestObserver();
    act(() => {
      firstObserver.trigger(true);
      firstObserver.trigger(true);
    });
    expect(result.current.visibleCount).toBe(48);
    expect(firstObserver.disconnect).toHaveBeenCalledTimes(1);

    const secondObserver = latestObserver();
    expect(secondObserver).not.toBe(firstObserver);
    act(() => secondObserver.trigger(true));
    expect(result.current.visibleCount).toBe(60);
    expect(result.current.hasMore).toBe(false);
    expect(secondObserver.disconnect).toHaveBeenCalledTimes(1);
  });

  test('does nothing for a non-intersecting entry', () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    const { result } = renderHook(() => useIncrementalVideoItems(60));
    act(() => result.current.sentinelRef(document.createElement('button')));

    const observer = latestObserver();
    act(() => observer.trigger(false));

    expect(result.current.visibleCount).toBe(24);
    expect(result.current.hasMore).toBe(true);
    expect(observer.disconnect).not.toHaveBeenCalled();
  });

  test('disconnects on unmount and ignores a late observer callback', () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    const { result, unmount } = renderHook(() => useIncrementalVideoItems(60));
    act(() => result.current.sentinelRef(document.createElement('button')));
    const observer = latestObserver();

    unmount();
    act(() => observer.trigger(true));

    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(result.current.visibleCount).toBe(24);
  });

  test('leaves loading to the explicit button when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { result } = renderHook(() => useIncrementalVideoItems(60));
    act(() => result.current.sentinelRef(document.createElement('button')));

    expect(result.current.visibleCount).toBe(24);
    expect(TestIntersectionObserver.instances).toHaveLength(0);
    act(() => result.current.loadMore());
    expect(result.current.visibleCount).toBe(48);
  });

  test('preserves the current count and reconnects when the source list grows', () => {
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    const { result, rerender } = renderHook(
      ({ itemCount }) => useIncrementalVideoItems(itemCount),
      { initialProps: { itemCount: 24 } },
    );
    const sentinel = document.createElement('button');
    act(() => result.current.sentinelRef(sentinel));
    expect(result.current.hasMore).toBe(false);
    expect(TestIntersectionObserver.instances).toHaveLength(0);

    rerender({ itemCount: 48 });
    expect(result.current.visibleCount).toBe(24);
    expect(result.current.hasMore).toBe(true);
    const observer = latestObserver();
    act(() => observer.trigger(true));
    expect(result.current.visibleCount).toBe(48);

    rerender({ itemCount: 48 });
    expect(result.current.visibleCount).toBe(48);

    rerender({ itemCount: 60 });
    expect(result.current.visibleCount).toBe(48);
    expect(result.current.hasMore).toBe(true);
  });
});
