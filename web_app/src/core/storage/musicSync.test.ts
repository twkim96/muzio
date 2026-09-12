import { describe, expect, test } from 'vitest';
import { MusicSync, type MusicSnapshot, type MusicSyncClient, type MusicOperation, type MusicResult } from './musicSync';
import type { PlaylistRecord } from './playlistRepository';
class MemoryStorage implements Storage {
 data=new Map<string,string>(); get length(){return this.data.size;} key(i:number){return [...this.data.keys()][i]??null;}
 getItem(k:string){return this.data.get(k)??null;} setItem(k:string,v:string){this.data.set(k,v);} removeItem(k:string){this.data.delete(k);} clear(){this.data.clear();}
}
function server(){
 let snapshot:MusicSnapshot={revision:0,likes:{},playlists:{}};let posts=0;
 const client:MusicSyncClient={async get(rev){return rev===snapshot.revision?null:structuredClone(snapshot);},async post(ops){
  posts++;const results:MusicResult[]=[];
  for(const op of ops){const r:MusicResult={id:op.id,status:'conflict',revision:0};
   if(op.kind==='create'){
    const existing=Object.values(snapshot.playlists).find(p=>p.name.value===op.value&&!p.deleted.value);
    if(existing){r.status='noop';r.canonicalId=existing.id;r.revision=existing.name.revision;}
    else{const rev=++snapshot.revision;snapshot.playlists[op.playlistId!]={id:op.playlistId!,name:{value:op.value as string,revision:rev},deleted:{value:false,revision:0},items:{},order:{value:[],revision:0},createdAt:'2026-09-10T00:00:00Z'};r.status='applied';r.revision=rev;}
   }else{
    const p=snapshot.playlists[op.playlistId!];let cell=op.kind==='like'?snapshot.likes[op.key!]:op.kind==='item'?p?.items[op.key!]:op.kind==='order'?p?.order:undefined;
    if(cell&&JSON.stringify(cell.value)===JSON.stringify(op.value))r.status='noop';
    else if((cell?.revision??0)===op.baseRevision){cell={value:op.value as never,revision:++snapshot.revision};r.status='applied';if(op.kind==='like')snapshot.likes[op.key!]=cell as any;if(op.kind==='item'&&p)p.items[op.key!]=cell as any;if(op.kind==='order'&&p)p.order=cell as any;}
    r.revision=cell?.revision??0;
   }results.push(r);
  }return{snapshot:structuredClone(snapshot),results};}};
 return{client,state:()=>snapshot,posts:()=>posts,replace:(s:MusicSnapshot)=>{snapshot=s;}};
}
function device(client:MusicSyncClient){const storage=new MemoryStorage();const sync=new MusicSync(storage,client);const likes=()=>JSON.parse(storage.getItem('music.likes.v1')??'[]') as string[];const setLikes=(next:string[])=>{sync.recordLikes(likes(),next);storage.setItem('music.likes.v1',JSON.stringify(next));};return{storage,sync,likes,setLikes};}
const list=(id:string,keys:string[]):PlaylistRecord=>({id,name:'Mix',createdAt:'2026-09-10T00:00:00Z',updatedAt:'2026-09-10T00:00:00Z',items:keys.map(contentKey=>({contentKey,addedAt:'2026-09-10T00:00:00Z'}))});
describe('music desired-state sync',()=>{
 test('two devices liking the same song converge without a second toggle',async()=>{const s=server(),a=device(s.client),b=device(s.client);await a.sync.sync();await b.sync.sync();a.setLikes(['song']);b.setLikes(['song']);await a.sync.sync();await b.sync.sync();expect(s.state().revision).toBe(1);expect(b.likes()).toEqual(['song']);a.setLikes([]);await a.sync.sync();await b.sync.sync();expect(b.likes()).toEqual([]);});
 test('offline edits survive recreation but cannot resurrect a newer removal',async()=>{const s=server(),a=device(s.client),b=device(s.client);await a.sync.sync();await b.sync.sync();b.setLikes(['song']);a.setLikes(['song']);await a.sync.sync();a.setLikes([]);await a.sync.sync();await new MusicSync(b.storage,s.client).sync();expect(b.likes()).toEqual([]);expect([...b.storage.data.keys()].filter(k=>k.includes('.op.'))).toHaveLength(0);});
 test('local opposite actions before acknowledgment retain their ordering',async()=>{const s=server(),d=device(s.client);await d.sync.sync();d.setLikes(['song']);d.setLikes([]);await d.sync.sync();expect(d.likes()).toEqual([]);expect(s.state().likes.song.value).toBe(false);expect(s.state().likes.song.revision).toBe(2);});
 test('new intent during an in-flight post survives acknowledgment',async()=>{const s=server();let release=()=>{},entered=()=>{};const started=new Promise<void>(r=>{entered=r;});const client={...s.client,post:async(ops:MusicOperation[])=>{if(ops.some(op=>op.value===true)){entered();await new Promise<void>(r=>{release=r;});}return s.client.post(ops);}};const d=device(client);await d.sync.sync();d.setLikes(['song']);const running=d.sync.sync();await started;d.setLikes([]);release();await running;expect(d.likes()).toEqual([]);expect(s.state().likes.song.value).toBe(false);});
 test('initial migration merges legacy data while respecting server tombstones',async()=>{const s=server();s.replace({revision:3,likes:{gone:{value:false,revision:1},remote:{value:true,revision:2}},playlists:{p:{id:'p',name:{value:'Mix',revision:3},deleted:{value:false,revision:0},items:{gone:{value:false,revision:3}},order:{value:[],revision:0},createdAt:'2026-09-10T00:00:00Z'}}});const d=device(s.client);d.storage.setItem('music.likes.v1',JSON.stringify(['gone','local']));d.storage.setItem('music.playlists.v1',JSON.stringify({version:1,playlists:[list('old',['gone','new'])]}));await d.sync.sync();expect(d.likes().sort()).toEqual(['local','remote']);const p=JSON.parse(d.storage.getItem('music.playlists.v1')!).playlists;expect(p).toHaveLength(1);expect(p[0].id).toBe('p');expect(p[0].items.map((x:any)=>x.contentKey)).toEqual(['new']);});
 test('offline same-name playlists converge on one id with both memberships',async()=>{const s=server(),a=device(s.client),b=device(s.client);await a.sync.sync();await b.sync.sync();for(const [d,id,key] of [[a,'a','first'],[b,'b','second']] as const){const next=[list(id,[key])];d.sync.recordPlaylists([],next);d.storage.setItem('music.playlists.v1',JSON.stringify({version:1,playlists:next}));}await a.sync.sync();await b.sync.sync();await a.sync.sync();expect(Object.keys(s.state().playlists)).toEqual(['a']);expect(Object.keys(s.state().playlists.a.items).sort()).toEqual(['first','second']);expect(JSON.parse(b.storage.getItem('music.playlists.v1')!).playlists[0].id).toBe('a');});
 test('failure leaves the outbox and optimistic state intact for retry',async()=>{const s=server();let failing=true;const d=device({...s.client,post:async(ops)=>{if(failing)throw Error('offline');return s.client.post(ops);}});await d.sync.sync();d.setLikes(['song']);await d.sync.sync();expect(d.sync.getStatus()).toBe('offline');expect(d.likes()).toEqual(['song']);failing=false;await d.sync.sync();expect(s.state().likes.song.value).toBe(true);expect(d.sync.getStatus()).toBe('idle');});
 test('native edits are drained before refreshing the remote revision',async()=>{const s=server(),d=device(s.client);await d.sync.sync();s.replace({revision:2,likes:{song:{value:false,revision:2}},playlists:{}});let drained=false;d.sync.beforeSync=async()=>{if(!drained){drained=true;d.setLikes(['song']);}};await d.sync.sync();expect(d.likes()).toEqual([]);});
 test('unchanged refresh sends no mutation',async()=>{const s=server(),d=device(s.client);await d.sync.sync();await d.sync.sync();expect(s.posts()).toBe(0);});
 test('legacy import preserves track order and does not recreate a deleted same-name list',async()=>{
  const s=server(),d=device(s.client);d.storage.setItem('music.playlists.v1',JSON.stringify({version:1,playlists:[list('old',['z','a'])]}));await d.sync.sync();expect(s.state().playlists.old.order.value).toEqual(['z','a']);
  const snapshot=structuredClone(s.state());snapshot.playlists.old.deleted={value:true,revision:++snapshot.revision};s.replace(snapshot);
  const late=device(s.client);late.storage.setItem('music.playlists.v1',JSON.stringify({version:1,playlists:[list('another',['z'])]}));await late.sync.sync();expect(JSON.parse(late.storage.getItem('music.playlists.v1')!).playlists).toEqual([]);expect(Object.keys(s.state().playlists)).toEqual(['old']);
 });

});
