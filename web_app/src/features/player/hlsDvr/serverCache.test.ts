import { afterEach, expect, test, vi } from 'vitest';
import { temporaryHlsSource } from '../temporaryHlsSource';
import { prepareServerHls, pingHlsSession } from './serverCache';
afterEach(() => vi.unstubAllGlobals());
const stream='https://example.com/live?sig=a%2Bb';
test('independent viewers use the shared ID and cache returned by the server',async()=>{
 const requests:Record<string,string>[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({id:'shared-hls',playbackUrl:'/api/hls-cache/shared/media.m3u8'}))}));
 const a=await prepareServerHls(temporaryHlsSource(stream)),b=await prepareServerHls(temporaryHlsSource(stream));
 expect(a).toMatchObject({mediaId:'shared-hls',hlsOriginalUrl:stream,url:`${location.origin}/api/hls-cache/shared/media.m3u8`});expect(b.mediaId).toBe(a.mediaId);expect(b.url).toBe(a.url);
 expect(requests).toHaveLength(2);expect(requests.every(r=>r.action==='register'&&r.url===stream&&!('tab' in r))).toBe(true);
 await pingHlsSession(a.mediaId);expect(requests[2]).toEqual({action:'heartbeat',id:'shared-hls'});
});
test('reentry registers the original signed URL again so an expired session can be recreated',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({id:'fresh',playbackUrl:'/api/hls-cache/new/media.m3u8'}))));
 const result=await prepareServerHls({...temporaryHlsSource(stream),hlsOriginalUrl:stream,url:`${location.origin}/api/hls-cache/expired/media.m3u8`});expect(result.mediaId).toBe('fresh');
 expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).url).toBe(stream);
});
test('registration failure does not return a playable source',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:507})));
 await expect(prepareServerHls(temporaryHlsSource(stream))).rejects.toThrow('저장 공간');
});
