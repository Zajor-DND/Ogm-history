import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolveClip,clipAllowed,acceptPacket,TokenAnimationPlayer,facingAngle,firstFacingTarget,TokenDispatchQueue,targetEffectFile} from '../scripts/token-animation-core.mjs';
const data=JSON.parse(fs.readFileSync('data/animations.json','utf8'));
const actor=(key,extra={})=>({flags:{'pod-parusom':{key,...extra}},isOwner:true,testUserPermission:()=>true});
const item=(key,name='Ability')=>({name,flags:{'pod-parusom':{key}}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function token(id='t') {const tex={id:'static-'+id};return {document:{uuid:'Scene.s.Token.'+id,texture:{src:'original.png'}},texture:tex,mesh:{texture:tex},isVisible:true,actor:actor('VL'),renderFlags:{set(){}}};}
function harness(options={}) {
  let scene='s',calls=0,disposed=0;const assets=[];
  const p=new TokenAnimationPlayer({sceneId:()=>scene,log:()=>{},prepare:async(clip,signal)=>{
    calls++;await delay(options.prepareDelay??0);
    const asset={texture:{id:'video-'+calls},dispose(){disposed++;},async play(signal){
      options.during?.(clip,asset);if(options.error)throw Error('decode error');
      await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,options.duration??5);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('aborted'));},{once:true});});
    }};assets.push(asset);return asset;
  },...options.player});return {p,assets,get calls(){return calls;},get disposed(){return disposed;},setScene(s){scene=s;}};
}
test('81 clips, 76 item bindings; all referenced files exist',()=>{
  assert.equal(Object.keys(data.clips).length,81);assert.equal(Object.keys(data.itemBindings).length,76);
  for(const [key,cid] of Object.entries(data.itemBindings)){assert.ok(data.clips[cid],key);assert.ok(fs.existsSync(''+data.clips[cid].file));}
  assert.ok(!data.clips['09_02']);
});
test('all imported Activity keys resolve to their own actor profile',()=>{
  const content=JSON.parse(fs.readFileSync('data/content.json'));
  let count=0;
  for(const a of content.actors)for(const i of a.items){const cid=data.itemBindings[i.flags?.['pod-parusom']?.key];if(!cid)continue;
    assert.equal(resolveClip({actor:a,item:i},data)?.id,cid);count++;}
  assert.ok(count>=76);
});
test('multiattack itself never resolves, including a forged override',()=>{
  const i=item('VL:actions:0:Мультиатака','Мультиатака');i.flags['pod-parusom'].tokenAnimation='01_01';
  assert.equal(resolveClip({actor:actor('VL'),item:i},data),null);
});
test('cancelled workflow does not animate',()=>assert.equal(resolveClip({aborted:true,actor:actor('VL'),item:item('VL:actions:1:Массивный кулак')},data),null));
test('wrong-profile override cannot animate another character',()=>{
  const i=item('x');i.flags['pod-parusom'].tokenAnimation='16_02';assert.equal(resolveClip({actor:actor('VL'),item:i},data),null);
});
test('missing militia knife gets no substituted animation',()=>assert.equal(resolveClip({actor:actor('MILS'),item:item('MILS:actions:2:Нож','Нож')},data),null));
test('civilian aliases and broken Piero are scoped correctly',()=>{
  for(const key of ['BRUNO','LIZEL','GERHARD'])assert.ok(clipAllowed(actor(key),data.clips['17_01'],data));
  assert.ok(clipAllowed(actor('PIEB',{broken:true,profile:'PIE'}),data.clips['12_03'],data));
  assert.ok(!clipAllowed(actor('PIE',{broken:true}),data.clips['12_01'],data));
});
test('conditional damage variants resolve only for the matching profile',()=>{
  assert.equal(resolveClip({actor:actor('F'),item:item('x'),podParusomAnimationVariant:'03_07'},data).id,'03_07');
  assert.equal(resolveClip({actor:actor('REGM'),item:item('x'),podParusomAnimationVariant:'18_06'},data).id,'18_06');
});
test('successful playback replaces only the texture and restores it',async()=>{
  const t=token(),original=t.texture,doc=structuredClone(t.document);const h=harness({during:(_c,a)=>assert.equal(t.mesh.texture,a.texture)});
  assert.equal(await h.p.play(t,data.clips['01_01']),true);assert.equal(t.texture,original);assert.equal(t.mesh.texture,original);assert.deepEqual(t.document,doc);assert.equal(h.disposed,1);
});
test('decoder error restores static texture',async()=>{
  const t=token(),original=t.texture,h=harness({error:true});assert.equal(await h.p.play(t,data.clips['01_01']),false);assert.equal(t.mesh.texture,original);assert.equal(h.disposed,1);
});
test('same-token abilities queue without overlapping textures',async()=>{
  const t=token(),original=t.texture,order=[];const h=harness({duration:8,during:c=>order.push(c.id)});
  assert.deepEqual(await Promise.all([h.p.play(t,data.clips['01_01']),h.p.play(t,data.clips['01_02'])]),[true,true]);
  assert.deepEqual(order,['01_01','01_02']);assert.equal(t.texture,original);assert.equal(h.disposed,2);
});
test('different tokens play independent cloned textures',async()=>{
  const a=token('a'),b=token('b'),h=harness({duration:30});const promises=[h.p.play(a,data.clips['01_01']),h.p.play(b,data.clips['01_02'])];
  await delay(8);assert.notEqual(a.texture,b.texture);assert.notEqual(a.texture.id,'static-a');await Promise.all(promises);
});
test('scene change while loading never swaps a texture',async()=>{
  const t=token(),original=t.texture,h=harness({prepareDelay:20});const result=h.p.play(t,data.clips['01_01']);h.setScene('other');assert.equal(await result,false);assert.equal(t.texture,original);assert.equal(h.disposed,1);
});
test('teardown cancels playback and queued jobs, restoring immediately',async()=>{
  const t=token(),original=t.texture,h=harness({duration:1000});const one=h.p.play(t,data.clips['01_01']),two=h.p.play(t,data.clips['01_02']);
  await delay(8);h.p.stopAll();assert.equal(t.texture,original);assert.deepEqual(await Promise.all([one,two]),[false,false]);assert.equal(h.p.states.size,0);
});
test('cancellation while preparing releases the late texture',async()=>{
  const t=token(),original=t.texture,h=harness({prepareDelay:20});const promise=h.p.play(t,data.clips['01_01']);h.p.stopAll();assert.equal(await promise,false);assert.equal(t.texture,original);assert.equal(h.disposed,1);
});
test('native refresh retains the video until playback ends',async()=>{
  const t=token(),original=t.texture,h=harness({duration:40});const promise=h.p.play(t,data.clips['01_01']);await delay(10);const video=t.texture;
  t.texture=original;t.mesh.texture=original;h.p.refresh(t);assert.equal(t.mesh.texture,video);await promise;assert.equal(t.texture,original);
});
test('external image change is not overwritten by cleanup',async()=>{
  const t=token(),h=harness({duration:100});const promise=h.p.play(t,data.clips['01_01']);await delay(10);
  const external={id:'external'};t.document.texture.src='new.png';t.texture=external;t.mesh.texture=external;h.p.refresh(t);assert.equal(await promise,false);assert.equal(t.texture,external);
});
test('invisible tokens never load or play videos',async()=>{
  const t=token();t.isVisible=false;const h=harness();assert.equal(await h.p.play(t,data.clips['01_01']),false);assert.equal(h.calls,0);
});
test('queue has a bounded length',async()=>{
  const t=token(),h=harness({duration:40,player:{maxQueue:1}});const a=h.p.play(t,data.clips['01_01']),b=h.p.play(t,data.clips['01_02']);
  assert.equal(await h.p.play(t,data.clips['01_03']),false);await Promise.all([a,b]);
});
test('packet validation rejects wrong scenes, expired events and unauthorized users',()=>{
  const t=token(),now=Date.now(),gm={id:'gm',active:true,isGM:true};const packet={type:'tokenAnimation',id:'event',clipId:'01_01',createdAt:now,sceneId:'s',tokenUuid:t.document.uuid};const env={user:gm,token:t,sceneId:'s',now};
  assert.ok(acceptPacket(packet,data,env));
  for(const bad of [{sceneId:'other'},{createdAt:now-40000},{clipId:'16_02'},{tokenUuid:'other'},{id:undefined}])assert.equal(acceptPacket({...packet,...bad},data,env),false);
  t.actor.testUserPermission=()=>false;assert.equal(acceptPacket(packet,data,{...env,user:{active:true,isGM:false}}),false);
});

test('facing angles match south-facing artwork, including diagonals and different token sizes',()=>{
  const source={center:{x:100,y:100}};
  for(const [x,y,angle] of [[100,200,0],[0,100,90],[100,0,180],[200,100,270],[200,200,315]])
    assert.equal(facingAngle(source,{center:{x,y}}),angle);
  assert.equal(facingAngle(source,source),null);
  assert.equal(facingAngle(source,{center:{x:NaN,y:0}}),null);
});
test('facing chooses the first non-self, valid target; self abilities do not turn',()=>{
  const t=token();t.center={x:50,y:50};const target={document:{uuid:'other'},center:{x:150,y:50}};
  assert.equal(firstFacingTarget(t,[t,{center:{}},target]),target);
  assert.equal(firstFacingTarget(t,[t]),null);assert.equal(firstFacingTarget(t,[]),null);
});
test('turn and clip dispatch serialize for a token, recover after failure, and do not block another token',async()=>{
  const q=new TokenDispatchQueue(),events=[];
  const one=q.run('a',async()=>{events.push('a1-turn');await delay(10);events.push('a1-end');throw Error('failure');});
  const two=q.run('a',async()=>{events.push('a2-turn');});
  const other=q.run('b',async()=>{events.push('b-turn');});
  await Promise.allSettled([one,two,other]);
  assert.ok(events.indexOf('a2-turn')>events.indexOf('a1-end'));
  assert.ok(events.indexOf('b-turn')<events.indexOf('a1-end'));assert.equal(q.pending.size,0);
});
test('legacy projectile is suppressed while healing, melee and burst effects remain available',()=>{
  assert.equal(targetEffectFile('projectile'),null);
  assert.equal(targetEffectFile('heal'),'heal.svg');assert.equal(targetEffectFile('melee'),'slash.svg');assert.equal(targetEffectFile('burst'),'burst.svg');
});
