import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PlayerProvider } from '../PlayerContext';
import { createPlayerStore } from '../playerStore';
import { PlayerOverlayProvider } from '../PlayerOverlayContext';
import { SharedHlsSessions, SharedHlsSessionSync } from './sharedSessions';
import { temporaryHlsSource } from '../temporaryHlsSource';
import { MemoryRouter } from 'react-router-dom';
const stream='https://example.com/live.m3u8?signature=a%2Bb';
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals()});
function mount(children:React.ReactNode,store=createPlayerStore()){
 return {store,...render(<MemoryRouter><PlayerProvider store={store}><PlayerOverlayProvider>{children}</PlayerOverlayProvider></PlayerProvider></MemoryRouter>)};
}
test('the current shared session opens without reloading playback',async()=>{
 const source=temporaryHlsSource(stream,'Live one');const store=createPlayerStore();await store.getState().playSource(source);const play=vi.spyOn(store.getState(),'playSource');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({items:[{id:source.mediaId,url:stream,title:'Live one',state:'live'}]}))));
 mount(<SharedHlsSessions/>,store);fireEvent.click(await screen.findByRole('button',{name:/^Live one/}));expect(play).not.toHaveBeenCalled();
});
test('another viewer reenters the same shared ended cache',async()=>{
 const requests:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST')requests.push(JSON.parse(init.body).action);return new Response(JSON.stringify(init?.method==='POST'?{id:'shared-ended',playbackUrl:'/api/hls-cache/shared/media.m3u8'}:{items:[{id:'shared-ended',url:stream,title:'Ended',state:'ended',playbackUrl:'/api/hls-cache/shared/media.m3u8'}]}))}));
 const {store}=mount(<SharedHlsSessions/>);fireEvent.click(await screen.findByRole('button',{name:/^Ended/}));
 await waitFor(()=>expect(store.getState().video.source).toMatchObject({mediaId:'shared-ended',hlsOriginalUrl:stream,url:`${location.origin}/api/hls-cache/shared/media.m3u8`}));expect(requests).toEqual(['register']);
});
test('paused video heartbeats once a minute, and leaving or changing media never closes the shared stream',async()=>{
 const requests:Record<string,string>[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(null,{status:204})}));
 const store=createPlayerStore();const source={...temporaryHlsSource(stream),mediaId:'shared-one'};await store.getState().playSource(source);store.getState().pauseActive();
 vi.useFakeTimers();const view=mount(<SharedHlsSessionSync/>,store);await act(async()=>{await vi.advanceTimersByTimeAsync(120_000)});
 expect(requests).toEqual(Array.from({length:3},()=>({action:'heartbeat',id:'shared-one'})));
 // A different active video stops acknowledgements for the old HLS.
 await act(async()=>{await store.getState().playSource({...source,mediaId:'shared-two'})});await act(async()=>{await vi.advanceTimersByTimeAsync(60_000)});
 expect(requests.slice(3)).toEqual([{action:'heartbeat',id:'shared-two'},{action:'heartbeat',id:'shared-two'}]);
 const before=requests.length;act(()=>window.dispatchEvent(new Event('pagehide')));view.unmount();await act(async()=>{await vi.advanceTimersByTimeAsync(120_000)});
 expect(requests).toHaveLength(before);expect(requests.some(r=>r.action==='close')).toBe(false);
});

test('shows the shared frame beside the stream title and falls back if it expires',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({items:[{id:'with-thumbnail',url:stream,title:'Preview stream',state:'live',thumbnailUrl:'/api/hls-cache/shared/thumbnail.jpg?v=1'}]}))));
 mount(<SharedHlsSessions/>);const button=await screen.findByRole('button',{name:/^Preview stream/});const img=button.querySelector('img');expect(img).toHaveAttribute('src','/api/hls-cache/shared/thumbnail.jpg?v=1');fireEvent.error(img!);expect(button.querySelector('img')).toBeNull();expect(button).toHaveTextContent('Preview stream');
});

test('shows stored size and deletes only the selected session without opening playback',async()=>{
 const requests:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST'){requests.push(JSON.parse(init.body).action);return new Response(null,{status:204})};return new Response(JSON.stringify({items:[{id:'a',url:stream,title:'A',state:'live',bytes:268435456},{id:'b',url:stream,title:'B',state:'live',bytes:0}]}))}));
 const {store}=mount(<SharedHlsSessions/>);expect(await screen.findByText('라이브 · 256.0MB / 1GB')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'저장분 삭제: A'}));await waitFor(()=>expect(screen.queryByRole('button',{name:'저장분 삭제: A'})).toBeNull());expect(screen.getByRole('button',{name:'저장분 삭제: B'})).toBeInTheDocument();expect(store.getState().video.source).toBeNull();expect(requests).toEqual(['delete']);
});
test('failed deletion leaves the session visible with a retryable error',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>init?.method==='POST'?new Response(null,{status:500}):new Response(JSON.stringify({items:[{id:'a',url:stream,title:'A',state:'live',bytes:123}]}))));
 mount(<SharedHlsSessions/>);fireEvent.click(await screen.findByRole('button',{name:'저장분 삭제: A'}));expect(await screen.findByRole('alert')).toHaveTextContent('삭제하지 못했습니다');expect(screen.getByRole('button',{name:'저장분 삭제: A'})).toBeEnabled();
});

test('shows the last viewing signal from the server rather than the list fetch time',async()=>{
 const lastSeenAt=Date.parse('2026-09-14T02:08:23Z');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({items:[{id:'a',url:stream,title:'A',state:'live',bytes:0,lastSeenAt}]}))));
 mount(<SharedHlsSessions/>);
 const time=new Date(lastSeenAt).toLocaleTimeString('ko-KR',{hour12:false,hour:'2-digit',minute:'2-digit'});
 expect(await screen.findByText(time)).toHaveAttribute('title',`마지막 시청 신호: ${new Date(lastSeenAt).toLocaleString('ko-KR')}`);
});
