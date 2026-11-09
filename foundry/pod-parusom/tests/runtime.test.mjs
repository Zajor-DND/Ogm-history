import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const index=JSON.parse(fs.readFileSync('data/animations.json'));
const handlers=new Map(),once=new Map(),settings=new Map(),packets=[];let cloneCount=0,failPlay=false;
class FakeVideo extends EventTarget {
  constructor(){super();this.paused=true;this.currentTime=0;}
  play(){if(failPlay)return Promise.reject(Error('autoplay blocked'));this.paused=false;setTimeout(()=>{if(!this.paused)this.dispatchEvent(new Event('ended'));},6);return Promise.resolve();}
  pause(){this.paused=true;}
}
function texture(source){return {baseTexture:{resource:{source}},destroyed:false,destroy(){this.destroyed=true;source.pause();}};}
const actor={flags:{'pod-parusom':{key:'VL'}},isOwner:true,testUserPermission:()=>true};
const staticTexture={id:'original'};
const token={id:'t',name:'Test token',actor,document:{uuid:'Scene.s.Token.t',texture:{src:'original.png'}},texture:staticTexture,mesh:{texture:staticTexture},isVisible:true,renderFlags:{set(){}}};
const turns=[];token.center={x:100,y:100};token.document.update=async(changes,options)=>{turns.push({changes,options,packetCount:packets.length});Object.assign(token.document,changes);};
globalThis.Hooks={once:(name,fn)=>once.set(name,fn),on:(name,fn)=>handlers.set(name,fn)};
globalThis.canvas={scene:{id:'s'},tokens:{placeables:[token],controlled:[token],get:id=>id==='t'?token:null}};
globalThis.game={user:{id:'gm',isGM:true,active:true},users:new Map([['gm',{id:'gm',isGM:true,active:true}]]),modules:new Map([['pod-parusom',{api:{}}],['midi-qol',{active:true}]]),settings:{register:(_m,k,opt)=>settings.set(k,opt.default),get:(_m,k)=>settings.get(k)},video:{getVideoSource:mesh=>mesh.texture.baseTexture?.resource?.source,cloneTexture:async()=>{cloneCount++;return texture(new FakeVideo());}},socket:{emit:(_c,p)=>packets.push(p),on:(_c,fn)=>handlers.set('socket',fn)}};
let random=0;globalThis.foundry={utils:{randomID:()=>String(++random)},canvas:{loadTexture:async()=>texture(new FakeVideo())}};
globalThis.fetch=async()=>({ok:true,json:async()=>index});
globalThis.ui={notifications:{warn(){},info(){}}};
const oldWarn=console.warn;console.warn=()=>{};
await import('../scripts/token-animations.mjs');once.get('init')();once.get('ready')();
const complete=w=>handlers.get('midi-qol.RollComplete')(w);
function workflow(extra={}){return {userId:'gm',actor,token,item:{name:'Массивный кулак',flags:{'pod-parusom':{key:'VL:actions:1:Массивный кулак'}}},...extra};}
test('runtime duplicates one RollComplete event only once',async()=>{
  const start=cloneCount,w=workflow();await Promise.all([complete(w),complete(w)]);assert.equal(cloneCount-start,1);assert.equal(token.texture,staticTexture);assert.equal(token.mesh.texture,staticTexture);assert.equal(packets.at(-1).clipId,'01_01');
});
test('socket echo does not replay the same packet',async()=>{
  const start=cloneCount;handlers.get('socket')(packets.at(-1));await new Promise(r=>setTimeout(r,10));assert.equal(cloneCount,start);
});
test('a remote owner request plays on the receiving client exactly once',async()=>{
  game.users.set('owner',{id:'owner',isGM:false,active:true});const start=cloneCount;
  const packet={type:'tokenAnimation',id:'remote-owner-1',userId:'owner',clipId:'01_02',tokenUuid:token.document.uuid,sceneId:'s',createdAt:Date.now()};
  handlers.get('socket')(packet);handlers.get('socket')(packet);await new Promise(r=>setTimeout(r,20));assert.equal(cloneCount,start+1);assert.equal(token.texture,staticTexture);
});
test('aborted, unrelated and remote-owner workflows never broadcast',async()=>{
  const n=packets.length;await complete(workflow({aborted:true}));await complete(workflow({userId:'other'}));await complete(workflow({item:{name:'Unrelated'}}));assert.equal(packets.length,n);
});
test('native clone is disposed after autoplay failure and static texture is restored',async()=>{
  failPlay=true;await complete(workflow());failPlay=false;assert.equal(token.texture,staticTexture);assert.equal(token.mesh.texture,staticTexture);
});
test('client preference disables local playback without disabling broadcasts to other clients',async()=>{
  settings.set('tokenAnimationsClient',false);const start=cloneCount,n=packets.length;await complete(workflow());assert.equal(packets.length,n+1);assert.equal(cloneCount,start);settings.set('tokenAnimationsClient',true);
});
test('world preference disables workflow animations for everyone',async()=>{
  settings.set('tokenAnimations',false);const n=packets.length;await complete(workflow());assert.equal(packets.length,n);settings.set('tokenAnimations',true);
});
test('TokenDocument workflow source resolves the precise scene token',async()=>{
  const start=cloneCount;await complete(workflow({token:{id:'t'},tokenId:'t'}));assert.equal(cloneCount,start+1);
});
test('two legitimate uses of the same ability have independent playback',async()=>{
  const start=cloneCount;await complete(workflow());await complete(workflow());assert.equal(cloneCount,start+2);
});
test('API preview does not update token documents or actor data',async()=>{
  const before=JSON.stringify(token.document),a=JSON.stringify(actor.flags);const api=game.modules.get('pod-parusom').api.tokenAnimations;
  assert.equal(await api.playToken(token,'01_01'),true);assert.equal(JSON.stringify(token.document),before);assert.equal(JSON.stringify(actor.flags),a);
});
test('API exposes diagnostics and scene teardown cleanup',async()=>{
  const api=game.modules.get('pod-parusom').api.tokenAnimations;const d=await api.diagnostics();assert.equal(d.clips,81);assert.equal(d.itemBindings,76);handlers.get('canvasTearDown')();assert.equal(token.texture,staticTexture);console.warn=oldWarn;
});

const east={document:{uuid:'Scene.s.Token.east'},center:{x:200,y:100}};
const north={document:{uuid:'Scene.s.Token.north'},center:{x:100,y:0}};
test('workflow turns before broadcasting its clip and keeps direction after static restoration',async()=>{
  const n=packets.length;await complete(workflow({targets:new Set([east])}));
  assert.equal(turns.at(-1).changes.rotation,270);assert.equal(turns.at(-1).packetCount,n);
  assert.equal(turns.at(-1).options.animate,false);assert.equal(token.document.rotation,270);
  assert.equal(token.texture,staticTexture);
});
test('workflow without a target does not reuse the UI selection',async()=>{
  game.user.targets=new Set([north]);const n=turns.length;await complete(workflow({targets:new Set()}));assert.equal(turns.length,n);game.user.targets=new Set();
});
test('locked rotation and disabled facing preference both preserve clip playback',async()=>{
  const api=game.modules.get('pod-parusom').api.tokenAnimations,n=turns.length,start=cloneCount;
  token.document.lockRotation=true;await api.playToken(token,'01_01',{targets:[north]});delete token.document.lockRotation;
  settings.set('faceAnimationTarget',false);await api.playToken(token,'01_01',{targets:[north]});settings.set('faceAnimationTarget',true);
  assert.equal(turns.length,n);assert.equal(cloneCount,start+2);
});
test('two rapid uses snapshot their targets and turn in playback order',async()=>{
  const n=turns.length,api=game.modules.get('pod-parusom').api.tokenAnimations,selection=new Set([east]);
  const a=api.playToken(token,'01_01',{targets:selection});selection.clear();selection.add(north);
  const b=api.playToken(token,'01_02',{targets:selection});await Promise.all([a,b]);
  assert.deepEqual(turns.slice(n).map(x=>x.changes.rotation),[270,180]);assert.equal(token.document.rotation,180);
});
test('a rejected document rotation still plays the clip',async()=>{
  const update=token.document.update,start=cloneCount;token.document.update=async()=>{throw Error('permission denied');};
  console.warn=()=>{};
  try {assert.equal(await game.modules.get('pod-parusom').api.tokenAnimations.playToken(token,'01_01',{targets:[east]}),true);assert.equal(cloneCount,start+1);}
  finally{token.document.update=update;console.warn=oldWarn;}
});
