import type { NativeShellMetadata } from './androidShell';

/** Native host message transport. No bridge means ordinary web playback. */
export interface NativeMessagePort extends NativeShellMetadata {
  postMessage(message: string): void;
  onmessage?: ((event: { data: string }) => void) | null;
}
export interface NativeBridge extends NativeShellMetadata {
  request<T = unknown>(command: string, payload?: object): Promise<T>;
  subscribe(listener: (event: { type: string; state?: unknown }) => void): () => void;
  dispose(): void;
}
export function nativeMessagePort(): NativeMessagePort | undefined {
  return typeof window === 'undefined' ? undefined
    : (window as Window & { MuzioNative?: NativeMessagePort }).MuzioNative;
}
export function createNativeBridge(port = nativeMessagePort()): NativeBridge | null {
  if (!port) return null;
  let sequence = 0;
  const listeners = new Set<(event: { type: string; state?: unknown }) => void>();
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const receive = ({ data }: { data: string }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'response') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(message.error || 'Native command failed'));
    } else if (typeof message.type === 'string') {
      listeners.forEach((listener) => listener(message));
    }
  };
  port.onmessage = receive;
  return {
    platform: port.platform,
    capabilities: port.capabilities,
    request<T>(command: string, payload?: object) {
      const id = `web-${Date.now()}-${++sequence}`;
      return new Promise<T>((resolve, reject) => {
        // Folder selection waits for a person, and large SAF scans can take longer.
        const timeoutMs = command.startsWith('localLibrary.') ? 300000 : 15000;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native command timed out: ${command}`)); }, timeoutMs);
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
        try { port.postMessage(JSON.stringify({ id, command, payload })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      if (port.onmessage === receive) port.onmessage = null;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Native bridge disposed')); }
      pending.clear(); listeners.clear();
    },
  };
}
