export function registerServiceWorker() {
  // Android packages the same UI inside its APK; a server service worker must
  // not replace those assets with another release or intercept native hosting.
  if (import.meta.env.VITE_MUZIO_ANDROID === '1') return;
  const enableDevPwa = import.meta.env.DEV && import.meta.env.VITE_ENABLE_PWA_DEV === '1';
  if (!import.meta.env.PROD && !enableDevPwa) return;
  if (enableDevPwa && !window.isSecureContext) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    if (navigator.serviceWorker.controller) {
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
    }

    void navigator.serviceWorker.register('/sw.js').then((registration) => {
      void registration.update();
      window.setInterval(() => {
        void registration.update();
      }, 60 * 60 * 1000);
    });
  });
}
