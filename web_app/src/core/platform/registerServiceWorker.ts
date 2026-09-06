import { nativeMessagePort } from './nativeBridge';

export function registerServiceWorker() {
  // Native hosts control their UI lifecycle; service workers must not intercept it.
  if (nativeMessagePort() || import.meta.env.VITE_MUZIO_ANDROID === '1') return;
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
