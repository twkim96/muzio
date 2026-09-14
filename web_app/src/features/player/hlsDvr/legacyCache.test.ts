import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { sweepLegacyHlsCache } from './legacyCache';
afterEach(()=>vi.unstubAllGlobals());
test('migration cleans abandoned bytes while preserving another active old-version tab', async()=>{
 vi.stubGlobal('indexedDB',new IDBFactory());const now=Date.now();const opening=indexedDB.open('muzio-temporary-hls-v1',1);
 opening.onupgradeneeded=()=>{opening.result.createObjectStore('bytes');opening.result.createObjectStore('meta',{keyPath:'id'});opening.result.createObjectStore('sessions',{keyPath:'id'});};
 const db=await new Promise<IDBDatabase>(resolve=>{opening.onsuccess=()=>resolve(opening.result)});
 await new Promise<void>(resolve=>{const tx=db.transaction(['bytes','meta','sessions'],'readwrite');for(const id of ['active','abandoned']){tx.objectStore('bytes').put(new ArrayBuffer(4),id);tx.objectStore('meta').put({id,session:id});tx.objectStore('sessions').put({id,at:now-(id==='active'?0:600_000)})};tx.oncomplete=()=>resolve()});
 await sweepLegacyHlsCache(now);
 const saved=await new Promise<IDBValidKey[]>(resolve=>{const r=db.transaction('bytes').objectStore('bytes').getAllKeys();r.onsuccess=()=>resolve(r.result)});expect(saved).toEqual(['active']);db.close();
});
