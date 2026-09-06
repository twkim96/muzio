import { androidShellBridge } from '../../core/platform/androidShell';
import { useNativeLocalLibrary } from '../library/nativeLocalLibrary';

export function LocalMusicFolders({ query }: { query: string }) {
  const { roots, items, enrichment, busy, error, run } = useNativeLocalLibrary();
  if (!androidShellBridge()) return null;
  const matches = query.trim().toLocaleLowerCase().split(/\s+/).every((word) =>
    `local music folders offline storage device 로컬 음악 폴더 오프라인 저장소 기기 ${roots.map((root) => root.name).join(' ')}`.toLocaleLowerCase().includes(word));
  return <section id="local-music-folders" hidden={!matches} className="min-w-0 border-t border-zinc-200/70 py-6 dark:border-white/10">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-2xl font-semibold">Local Music</h2><p className="mt-1 text-sm text-muted">이 기기의 음악 폴더를 추가합니다. 네트워크 음악과 함께 표시되며 오프라인에서도 재생할 수 있습니다.</p></div>
      <div className="flex gap-2"><button disabled={busy} onClick={() => void run('add')} className="muzio-glass-action">로컬 폴더 추가</button><button disabled={busy || roots.length === 0} onClick={() => void run('refresh')} className="muzio-glass-action muzio-glass-action-secondary">다시 스캔</button></div>
    </div>
    {busy && <p role="status" className="text-sm text-muted">폴더를 선택하거나 음악 목록을 불러오는 중…</p>}
    {!busy && enrichment?.scanning && <p role="status" className="mb-2 text-sm text-muted">중단된 폴더 목록을 이어서 불러오는 중…</p>}
    {!busy && !enrichment?.scanning && (enrichment?.pending ?? 0) > 0 && <p role="status" className="mb-2 text-sm text-muted">
      음악 목록은 준비됐습니다. 곡 정보 채우는 중 {Math.max(0, enrichment!.total - enrichment!.pending)}/{enrichment!.total}곡 · 지금 재생할 수 있습니다.
    </p>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    <ul className="divide-y divide-current/10">{roots.map((root) => <li key={root.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="truncate font-medium">{root.name}</p><p className="text-sm text-muted">{root.available ? `${items.filter((item) => item.storageId === root.id).length}곡 · 오프라인` : root.error || '접근할 수 없습니다. 폴더 권한을 다시 선택해 주세요.'}</p></div><button disabled={busy} aria-label={`로컬 폴더 제거 ${root.name}`} onClick={() => void run('remove', { id: root.id })} className="muzio-glass-action muzio-glass-action-secondary">제거</button></li>)}</ul>
    <p className="mt-3 text-xs text-muted">음악 파일은 복사하지 않습니다. 곡 정보는 차례로 채우고, 앱을 다시 열면 남은 작업을 이어갑니다. 폴더를 제거해도 원본 파일은 삭제되지 않습니다.</p>
  </section>;
}
