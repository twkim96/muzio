import { afterEach, expect, test, vi } from 'vitest';
import { connectHlsThumbnail } from './thumbnail';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()});
function videoRoot(){const root=document.createElement('div'),video=document.createElement('video');root.append(video);Object.defineProperties(video,{readyState:{value:2},videoWidth:{value:640},videoHeight:{value:480}});return root;}
test('captures the decoded video once and shares a small JPEG without opening another stream',async()=>{
 const draw=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);
 vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(callback=>callback(new Blob(['jpeg'],{type:'image/jpeg'})));
 const fetcher=vi.fn(async()=>new Response(null,{status:204}));vi.stubGlobal('fetch',fetcher);const root=videoRoot();const stop=connectHlsThumbnail(root,`${location.origin}/api/hls-cache/shared/media.m3u8`);
 await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());root.querySelector('video')!.dispatchEvent(new Event('playing'));await Promise.resolve();expect(fetcher).toHaveBeenCalledOnce();
 expect(fetcher.mock.calls[0]).toEqual([`${location.origin}/api/hls-cache/shared/thumbnail.jpg`,expect.objectContaining({method:'PUT',body:expect.any(Blob)})]);expect(draw).toHaveBeenCalledOnce();stop();
});
test('changing streams cancels a pending frame so it cannot upload under the old session',async()=>{
 let finish!:BlobCallback;vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn()} as unknown as CanvasRenderingContext2D);vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(callback=>{finish=callback});const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const stop=connectHlsThumbnail(videoRoot(),`${location.origin}/api/hls-cache/old/media.m3u8`);stop();finish(new Blob(['jpeg']));await Promise.resolve();expect(fetcher).not.toHaveBeenCalled();
});
