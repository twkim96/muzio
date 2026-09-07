/* Classic worker helper: durable, bounded media-prefix cache. */
(function (scope) {
  const MAX_ENTRY = 128 * 1024 * 1024;
  const MAX_TOTAL = 256 * 1024 * 1024;
  function retain(entries, entry) {
    const others = entries.filter((item) => item.identity !== entry.identity)
      .sort((a, b) => b.used - a.used);
    const kept = [entry];
    let bytes = entry.bytes ?? entry.blob.size;
    for (const item of others) {
      if (kept.length < 2 && bytes + (item.bytes ?? item.blob.size) <= MAX_TOTAL) {
        kept.push(item);
        bytes += item.bytes ?? item.blob.size;
      }
    }
    return kept;
  }
  function database(dbName = 'muzio-video-index-v1') {
    let opened;
    const open = () => opened || (opened = new Promise((resolve, reject) => {
      let abandoned = false;
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const entries = db.objectStoreNames.contains('entries')
          ? request.transaction.objectStore('entries')
          : db.createObjectStore('entries', { keyPath: 'key' });
        const blobs = db.createObjectStore('blobs');
        // Upgrade the previous combined records in the same version transaction.
        const cursor = entries.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          const { blob, ...metadata } = current.value;
          if (blob) {
            blobs.put(blob, metadata.key);
            current.update({ ...metadata, bytes: blob.size });
          }
          current.continue();
        };
      };
      request.onsuccess = () => {
        if (abandoned) { request.result.close(); return; }
        request.result.onversionchange = () => { request.result.close(); opened = undefined; };
        resolve(request.result);
      };
      request.onerror = () => { opened = undefined; reject(request.error); };
      request.onblocked = () => {
        abandoned = true;
        opened = undefined;
        reject(new Error('Index upgrade blocked'));
      };
    }));
    async function access(identity, revision, blob, mode = 'get') {
      if (blob && (blob.size <= 0 || blob.size > MAX_ENTRY)) throw new Error('Invalid index size');
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['entries', 'blobs'], 'readwrite');
        const entriesStore = tx.objectStore('entries');
        const blobsStore = tx.objectStore('blobs');
        let result;
        const read = entriesStore.getAll();
        read.onsuccess = () => {
          const entries = read.result;
          const existing = mode === 'touch'
            ? entries.filter((entry) => entry.identity === identity).sort((a, b) => b.used - a.used)[0]
            : entries.find((entry) => entry.key === identity + ':' + revision);
          if (mode === 'touch') revision = existing?.revision;
          const key = identity + ':' + revision;
          const valid = entries.filter((entry) => mode === 'delete' ? entry.key !== key : entry.identity !== identity || entry.key === key);
          const present = mode !== 'delete' && (blob || existing);
          let kept = valid;
          if (present) {
            const used = Math.max(Date.now(), ...entries.map((entry) => entry.used + 1));
            kept = retain(valid, { key, identity, revision, bytes: blob ? blob.size : existing.bytes, used });
            // Promotions only write this small metadata record.
            entriesStore.put(kept[0]);
            if (blob) {
              blobsStore.put(blob, key);
              result = blob;
            } else if (mode === 'touch') {
              result = { indexBytes: existing.bytes, revision };
            } else {
              const readBlob = blobsStore.get(key);
              readBlob.onsuccess = () => { result = readBlob.result; };
            }
          }
          for (const entry of entries) {
            if (!kept.some((item) => item.key === entry.key)) {
              entriesStore.delete(entry.key);
              blobsStore.delete(entry.key);
            }
          }
          if (mode === 'delete') blobsStore.delete(key);
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Index transaction failed'));
      });
    }
    return {
      get: (identity, revision) => access(identity, revision),
      put: (identity, revision, blob) => access(identity, revision, blob),
      touch: (identity) => access(identity, undefined, undefined, 'touch'),
      delete: (identity, revision) => access(identity, revision, undefined, 'delete'),
    };
  }
  function create({ store = database(), fetcher = fetch } = {}) {
    const fills = new Map();
    async function handle(request) {
      const url = new URL(request.url);
      // Chromium rejects mixing synthetic prefix and network seek responses
      // for no-CORS media, even when both URLs are same-origin. Old controlled
      // pages must keep their direct transport until they opt into CORS.
      if (request.mode === 'no-cors' && ['video', 'audio'].includes(request.destination)) return fetcher(request);
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') || '');
      if (request.method !== 'GET' || !range || url.searchParams.has('index') ||
          ['If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'].some((key) => request.headers.has(key))) return fetcher(request);
      const start = Number(range[1]);
      const requestedEnd = range[2] ? Number(range[2]) : undefined;
      if (!Number.isSafeInteger(start) || (requestedEnd !== undefined && (!Number.isSafeInteger(requestedEnd) || requestedEnd < start))) return fetcher(request);
      const identity = url.origin + url.pathname;
      let tail;
      try {
        const known = await store.touch(identity);
        if ((requestedEnd !== undefined && requestedEnd < 2) || start >= MAX_ENTRY || (known && known.indexBytes > 0 && start >= known.indexBytes)) return fetcher(request);
        const ifRange = request.headers.get('If-Range');
        // Only canonical HTTP dates can be matched against Last-Modified here.
        if (ifRange && (!Number.isFinite(Date.parse(ifRange)) || new Date(ifRange).toUTCString() !== ifRange)) return fetcher(request);
        const manifestURL = new URL(url);
        manifestURL.searchParams.set('index', 'manifest');
        const manifestResponse = await fetcher(new Request(manifestURL, { cache: 'no-store', credentials: request.credentials, signal: request.signal }));
        if (!manifestResponse.ok) throw new Error('Index manifest unavailable');
        const manifest = await manifestResponse.json();
        const { eligible, revision, fileSize, indexBytes, mimeType, modifiedAt } = manifest;
        if (ifRange && ifRange !== modifiedAt) return fetcher(request);
        if (!eligible || typeof revision !== 'string' || !revision || !Number.isSafeInteger(fileSize) || !Number.isSafeInteger(indexBytes) || indexBytes <= 0 || indexBytes > MAX_ENTRY || indexBytes > fileSize || start >= indexBytes) return fetcher(request);
        const end = Math.min(requestedEnd ?? fileSize - 1, fileSize - 1);
        let blob = await store.get(identity, revision);
        if (blob && blob.size !== indexBytes) {
          await store.delete(identity, revision);
          blob = undefined;
        }
        const cacheHit = Boolean(blob);
        if (!blob) {
          const key = identity + ':' + revision;
          let fill = fills.get(key);
          if (!fill || fill.controller.signal.aborted) {
            const controller = new AbortController();
            fill = { controller, users: 0 };
            fill.promise = (async () => {
              const dataURL = new URL(url);
              dataURL.searchParams.set('index', 'data');
              dataURL.searchParams.set('revision', revision);
              const response = await fetcher(new Request(dataURL, { cache: 'no-store', credentials: request.credentials, signal: controller.signal }));
              if (response.status !== 200 || Number(response.headers.get('Content-Length')) !== indexBytes) {
                await response.body?.cancel();
                throw new Error('Invalid index response');
              }
              const reader = response.body.getReader();
              const chunks = [];
              let size = 0;
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  size += value.byteLength;
                  if (size > indexBytes) throw new Error('Oversized index');
                  chunks.push(value);
                }
                if (size !== indexBytes) throw new Error('Truncated index');
              } catch (error) { await reader.cancel().catch(() => {}); throw error; }
              finally { reader.releaseLock(); }
              const downloaded = new Blob(chunks, { type: mimeType });
              await store.put(identity, revision, downloaded);
              return downloaded;
            })().finally(() => { if (fills.get(key) === fill) fills.delete(key); });
            fills.set(key, fill);
          }
          fill.users++;
          let onAbort;
          try {
            blob = await Promise.race([fill.promise, new Promise((_, reject) => {
              onAbort = () => reject(new Error('Request aborted'));
              request.signal.addEventListener('abort', onAbort, { once: true });
              if (request.signal.aborted) onAbort();
            })]);
          } finally {
            request.signal.removeEventListener('abort', onAbort);
            if (--fill.users === 0) fill.controller.abort();
          }
        }
        if (request.signal.aborted) throw new Error('Request aborted');
        if (blob.size !== indexBytes) throw new Error('Invalid cached index');
        if (end >= indexBytes) {
          const tailURL = new URL(url);
          tailURL.searchParams.set('index_revision', revision);
          const headers = new Headers(request.headers);
          headers.set('Range', `bytes=${indexBytes}-${end}`);
          tail = await fetcher(new Request(tailURL, { headers, credentials: request.credentials, signal: request.signal, cache: 'no-store' }));
          if (tail.status !== 206 || tail.headers.get('X-Muzio-Revision') !== revision || tail.headers.get('Content-Range') !== `bytes ${indexBytes}-${end}/${fileSize}` || Number(tail.headers.get('Content-Length')) !== end - indexBytes + 1 || !tail.body) throw new Error('Stale or invalid tail');
        }
        const prefix = blob.slice(start, Math.min(end + 1, indexBytes)).stream().getReader();
        const tailReader = tail?.body.getReader();
        let reader = prefix;
        let tailRemaining = Math.max(0, end - indexBytes + 1);
        const abort = () => { void cancel(request.signal.reason); };
        const cancel = async (reason) => {
          request.signal.removeEventListener('abort', abort);
          await Promise.allSettled([prefix.cancel(reason), tailReader?.cancel(reason)]);
        };
        request.signal.addEventListener('abort', abort, { once: true });
        const body = new ReadableStream({
          async pull(controller) {
            try {
              let chunk = await reader.read();
              if (chunk.done && reader === prefix && tailReader) { reader = tailReader; chunk = await reader.read(); }
              if (reader === tailReader && !chunk.done) {
                tailRemaining -= chunk.value.byteLength;
                if (tailRemaining < 0) throw new Error('Oversized tail');
              }
              if (chunk.done) {
                if (tailRemaining) throw new Error('Truncated tail');
                request.signal.removeEventListener('abort', abort);
                prefix.releaseLock();
                tailReader?.releaseLock();
                controller.close();
              } else controller.enqueue(chunk.value);
            } catch (error) { controller.error(error); await cancel(error); }
          }, cancel,
        });
        const headers = new Headers({ 'Content-Type': mimeType || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store', 'X-Muzio-Revision': revision, 'X-Muzio-Index-Cache': cacheHit ? 'hit' : 'miss' });
        if (modifiedAt) headers.set('Last-Modified', modifiedAt);
        return new Response(body, { status: 206, headers });
      } catch (_) {
        await tail?.body?.cancel().catch(() => {});
        return fetcher(request);
      }
    }
    return { handle };
  }
  scope.MuzioVideoIndexCache = { create, retain, database };
})(globalThis);
