import { useEffect, useState, type FormEvent } from 'react';
import { useAndroidBack, type AndroidShellBridge } from './androidShell';

export function AndroidServerSetup({ bridge }: { bridge: AndroidShellBridge }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [savedUrl, setSavedUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void bridge.request<{ baseUrl: string }>('shell.profile').then((profile) => {
      if (active) { setBaseUrl(profile.baseUrl); setSavedUrl(profile.baseUrl); }
    }).catch((error: unknown) => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [bridge]);
  const cancel = () => { void bridge.request(savedUrl ? 'shell.cancelSetup' : 'shell.background').catch((error: unknown) => setError(String(error))); };
  useAndroidBack(true, cancel);
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await bridge.request('shell.connect', { baseUrl: baseUrl.trim() }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <main className="flex min-h-screen items-center justify-center px-6 py-12">
    <form onSubmit={connect} className="muzio-dialog w-full max-w-md p-6">
      <h1 className="text-2xl font-semibold">Connect to Muzio</h1>
      <p className="mt-3 text-sm text-muted">Enter your Muzio server address to open your library.</p>
      <label className="mt-6 block text-sm" htmlFor="android-server-url">Server address</label>
      <input id="android-server-url" type="url" required autoCapitalize="none" autoCorrect="off" spellCheck={false}
        placeholder="http://192.168.1.10:8080" value={baseUrl} disabled={busy}
        onChange={(event) => setBaseUrl(event.target.value)} className="mt-2 w-full rounded-xl border border-white/20 bg-transparent px-3 py-3" />
      {error && <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>}
      <div className="mt-6 flex justify-end gap-3">
        {savedUrl && <button type="button" disabled={busy} onClick={cancel} className="rounded-xl px-4 py-2">Cancel</button>}
        <button type="submit" disabled={busy || !baseUrl.trim()} className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 disabled:opacity-50">{busy ? 'Connecting…' : 'Connect'}</button>
      </div>
    </form>
  </main>;
}
