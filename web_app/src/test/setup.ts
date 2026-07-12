import '@testing-library/jest-dom/vitest';

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
