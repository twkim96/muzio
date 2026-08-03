import '@testing-library/jest-dom/vitest';

// Node 25+ exposes an experimental global localStorage getter that resolves to
// undefined unless --localstorage-file is provided. Vitest's jsdom globals do
// not replace that pre-existing property, so install a test-only Storage before
// application modules (and Vidstack) read it. Real browsers are unaffected.
if (
  typeof process !== 'undefined' &&
  Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 25
) {
  class TestStorage implements Storage {
    private readonly values = new Map<string, string>();

    get length() {
      return this.values.size;
    }

    clear() {
      this.values.clear();
    }

    getItem(key: string) {
      return this.values.get(key) ?? null;
    }

    key(index: number) {
      return Array.from(this.values.keys())[index] ?? null;
    }

    removeItem(key: string) {
      this.values.delete(key);
    }

    setItem(key: string, value: string) {
      this.values.set(key, String(value));
    }
  }

  const storage = new TestStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  if (window !== globalThis) {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: storage,
    });
  }
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (typeof IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    disconnect() {}
    observe() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    unobserve() {}
  };
}

if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  };
}

if (
  typeof window !== 'undefined' &&
  typeof window.VTTCue !== 'function'
) {
  class MockVTTCue extends EventTarget {
    id = '';
    pauseOnExit = false;

    constructor(
      public startTime: number,
      public endTime: number,
      public text: string,
    ) {
      super();
    }

    getCueAsHTML(): DocumentFragment {
      return document.createDocumentFragment();
    }
  }

  Object.defineProperty(window, 'VTTCue', {
    configurable: true,
    value: MockVTTCue,
  });
}

// jsdom does not implement HTMLMediaElement.load/play/pause; tests that
// render real <audio>/<video> elements would otherwise pollute stderr with
// "Not implemented" errors that mask genuine failures. Stub them globally
// to silent no-ops; per-test fakes still control the engine layer.
if (typeof HTMLMediaElement !== 'undefined') {
  if (!('__vmaPatched' in HTMLMediaElement.prototype)) {
    Object.defineProperty(HTMLMediaElement.prototype, 'load', {
      configurable: true,
      value: function () {},
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: async function () {},
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: function () {},
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
      configurable: true,
      value: function (type: string) {
        return [
          'audio/mpeg',
          'audio/mp4',
          'audio/ogg',
          'audio/wav',
          'video/mp4',
          'video/webm',
          'video/ogg',
          'video/object',
        ].includes(type)
          ? 'probably'
          : '';
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, '__vmaPatched', {
      value: true,
    });
  }
}
