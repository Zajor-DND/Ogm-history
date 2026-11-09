import {ID,tag,profileOf,resolveClip,clipAllowed,acceptPacket,TokenAnimationPlayer,facingAngle,firstFacingTarget,TokenDispatchQueue} from './token-animation-core.mjs';
const BASE=`modules/${ID}/`, CHANNEL=`module.${ID}`;
let indexPromise;
const index=()=>indexPromise??=fetch(BASE+'data/animations.json').then(r=>{if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();}).catch(e=>{indexPromise=null;throw e;});
const worldEnabled=()=>game.settings.get(ID,'tokenAnimations');
const enabled=()=>worldEnabled() && game.settings.get(ID,'tokenAnimationsClient');
const clock=()=>Number.isFinite(game.time?.serverTime)?game.time.serverTime:Date.now();
const warn=e=>console.warn(ID,'Token animation',e);
function timeout(promise,ms,label) {
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));
}
const loading=new Map();
// Foundry 14 uses PIXI Texture<Resource>; VideoResource exposes its HTML video source.
function videoOf(texture) {
  const source=texture?.baseTexture?.resource?.source;
  return source && typeof source.play==='function' && typeof source.pause==='function' ? source : null;
}
async function cachedTexture(clip) {
  if(!loading.has(clip.file))loading.set(clip.file,Promise.resolve(foundry.canvas.loadTexture(BASE+clip.file)).finally(()=>loading.delete(clip.file)));
  const texture=await timeout(loading.get(clip.file),15000,'Видео не загрузилось за 15 секунд.');
  if(!texture)throw Error('Видео не найдено: '+clip.file);
  return texture;
}
async function prepare(clip,signal) {
  const cached=await cachedTexture(clip);
  if(signal.aborted)throw Error('Сцена закрыта.');
  const source=videoOf(cached);
  if(!source)throw Error('Ресурс не является видео: '+clip.file);
  // Never play or destroy the shared cached texture; every playback owns a clone.
  let expired=false;
  const cloning=game.video.cloneTexture(source).then(texture=>{
    if(expired||signal.aborted){texture?.destroy(true);throw Error('Загрузка видео отменена.');}return texture;
  });
  let texture;
  try {texture=await timeout(cloning,15000,'Не удалось подготовить видео.');}
  catch(e){expired=true;throw e;}
  const video=videoOf(texture);
  if(!video){texture.destroy(true);throw Error('Не найден источник WebM.');}
  try {video.muted=true;video.volume=0;video.loop=false;video.currentTime=0;}
  catch(e){texture.destroy(true);throw e;}
  return {
    texture,
    async play(abortSignal) {
      let timer;
      let ended,failed,aborted;
      const done=new Promise((resolve,reject)=>{
        ended=()=>resolve();failed=()=>reject(Error('Ошибка воспроизведения WebM.'));aborted=()=>reject(Error('Воспроизведение отменено.'));
        video.addEventListener('ended',ended,{once:true});video.addEventListener('error',failed,{once:true});
        abortSignal.addEventListener('abort',aborted,{once:true});
        timer=setTimeout(()=>reject(Error('Видео не завершилось вовремя.')),clip.durationMs+3000);
      });
      done.catch(()=>{});
      try {
        if(abortSignal.aborted)throw Error('Воспроизведение отменено.');
        await timeout(Promise.resolve(video.play()),2000,'Браузер не разрешил воспроизвести видео.');
        await done;
      } finally {
        clearTimeout(timer);video.removeEventListener('ended',ended);video.removeEventListener('error',failed);
        abortSignal.removeEventListener('abort',aborted);
      }
    },
    dispose(){video.pause();if(!texture.destroyed)texture.destroy(true);}
  };
}
const player=new TokenAnimationPlayer({prepare,sceneId:()=>canvas.scene?.id,log:warn});
const seen=new Map(), workflows=new WeakSet();
function remember(id) {
  if(seen.has(id))return false;seen.set(id,Date.now());
  if(seen.size>1000)seen.delete(seen.keys().next().value);return true;
}
function tokenFromUuid(uuid) {return canvas.tokens?.placeables?.find(t=>t.document.uuid===uuid);}
async function receive(packet) {
  try {
    if(!enabled())return false;
    const data=await index(),token=tokenFromUuid(packet?.tokenUuid);
    if(!acceptPacket(packet,data,{user:game.users.get(packet?.userId),token,sceneId:canvas.scene?.id,now:clock()}))return false;
    if(!remember(packet.id))return false;
    return await player.play(token,data.clips[packet.clipId]);
  } catch(e){warn(e);return false;}
}
const dispatch=new TokenDispatchQueue();
async function playToken(token,clipId,{targets=game.user.targets??[]}={}) {
  // Capture selection now; changing targets while a previous clip plays must not redirect this use.
  const target=firstFacingTarget(token,targets),scene=canvas.scene?.id;
  if(!token?.document?.uuid)return false;
  return dispatch.run(token.document.uuid,async()=>{
    try {
      if(!worldEnabled()||!token.actor||token.destroyed||canvas.scene?.id!==scene
        || (!game.user.isGM&&!token.actor.isOwner))return false;
      const data=await index();if(!clipAllowed(token.actor,data.clips[clipId],data))return false;
      if(game.settings.get(ID,'faceAnimationTarget')&&!token.document.lockRotation&&!target?.destroyed) {
        const angle=facingAngle(token,target);
        if(angle!==null) {
          try {await token.document.update({rotation:angle},{animate:false});}
          catch(e){warn(e);} // Cosmetic turning failure must not cancel the ability's clip.
        }
      }
      if(token.destroyed||canvas.scene?.id!==scene)return false;
      const packet={type:'tokenAnimation',id:foundry.utils.randomID(),userId:game.user.id,tokenUuid:token.document.uuid,sceneId:scene,clipId,createdAt:clock()};
      game.socket.emit(CHANNEL,packet);return await receive(packet);
    }catch(e){warn(e);return false;}
  });
}
function actorToken(actor) {
  if(actor?.token?.object)return actor.token.object;
  const tokens=actor?.getActiveTokens?.()??[];
  return canvas.tokens?.controlled?.find(t=>tokens.includes(t)) ?? (tokens.length===1?tokens[0]:null);
}
async function playForActor(actor,clipId){return playToken(actorToken(actor),clipId);}
async function workflowComplete(w) {
  try {
    if(!worldEnabled()||!w||typeof w!=='object'||w.aborted||workflows.has(w)||(w.userId&&w.userId!==game.user.id))return;
    workflows.add(w);
    const data=await index(),clip=resolveClip(w,data);if(!clip)return;
    const token=w.token?.object ?? (w.token?.document?w.token:undefined) ?? canvas.tokens?.get(w.tokenId??w.token?.id);
    if(token?.document)await playToken(token,clip.id,{targets:w.targets??[]});
  }catch(e){warn(e);}
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function animationPanel() {
  const token=canvas.tokens?.controlled?.[0];if(!token)return ui.notifications.warn('Выберите один токен приключения.');
  const data=await index(),profile=profileOf(token.actor,data);
  const clips=Object.values(data.clips).filter(c=>c.profile===profile&&clipAllowed(token.actor,c,data));
  if(!clips.length)return ui.notifications.warn('Для этого токена нет анимаций из набора.');
  return foundry.applications.api.DialogV2.wait({window:{title:'Парус · Анимации способностей'},content:`<p>${esc(token.name)}. Обычные способности запускают свои клипы автоматически через Midi-QOL. Просмотр ниже не применяет урон, состояния и не расходует действия.</p><select name="clip">${clips.map(c=>`<option value="${c.id}">${c.id} · ${esc(c.name)}${c.mode==='manual'?' (визуальный вариант)':''}</option>`).join('')}</select><p>Для варианта захвата вместо урона, общего Толчка и наведения без выстрела правила разрешает мастер. Выбор клипа не меняет механику Activity.</p>`,buttons:[{action:'play',label:'Проиграть один раз',callback:(_e,b)=>playToken(token,b.form.elements.clip.value)},{action:'preload',label:'Подгрузить клипы этого токена',callback:()=>preloadToken(token)},{action:'close',label:'Закрыть',default:true}],rejectClose:false});
}
async function preloadToken(token) {
  const data=await index(),clips=Object.values(data.clips).filter(c=>clipAllowed(token.actor,c,data));
  for(const clip of clips)await cachedTexture(clip);
  ui.notifications.info(`Подгружено ${clips.length} клипов в этом браузере.`);
}
async function diagnostics() {
  const data=await index();return {enabled:enabled(),clips:Object.keys(data.clips).length,itemBindings:Object.keys(data.itemBindings).length,missing:data.missing,manual:Object.values(data.clips).filter(c=>c.mode==='manual').map(c=>c.id),active:player.states.size};
}
Hooks.once('init',()=>{
  game.settings.register(ID,'tokenAnimations',{name:'Анимации токенов при применении способностей',hint:'Проигрывать WebM один раз и возвращать исходное изображение. Запускаются после завершения Activity в Midi-QOL.',scope:'world',config:true,type:Boolean,default:true,onChange:value=>{if(!value)player.stopAll();}});
  game.settings.register(ID,'faceAnimationTarget',{name:'Поворачивать токен к цели перед анимацией',hint:'Первая выбранная цель. Направление сохраняется после клипа. Без цели и при запрете вращения поворот пропускается.',scope:'world',config:true,type:Boolean,default:true});
  game.settings.register(ID,'tokenAnimationsClient',{name:'Показывать анимации токенов в этом браузере',scope:'client',config:true,type:Boolean,default:true,onChange:value=>{if(!value)player.stopAll();}});
});
Hooks.once('ready',()=>{
  const api=game.modules.get(ID).api;
  api.tokenAnimations={playToken,playForActor,diagnostics,stopAll:()=>player.stopAll(),preloadToken};
  api.animationsPanel=animationPanel;
  game.socket.on(CHANNEL,p=>{void receive(p);});
  if(game.user.isGM&&!game.modules.get('midi-qol')?.active)ui.notifications.warn('Парус: для автоматического запуска анимаций включите Midi-QOL. Просмотр клипов доступен в панели мастера.');
});
Hooks.on('midi-qol.RollComplete',workflowComplete);
Hooks.on('refreshToken',token=>player.refresh(token));
Hooks.on('updateToken',(doc,changes)=>{if(changes.texture||changes.ring||changes.hidden===true)player.stop(doc.uuid);});
Hooks.on('deleteToken',doc=>player.stop(doc.uuid));
Hooks.on('canvasTearDown',()=>player.stopAll());
Hooks.on('canvasReady',()=>player.stopAll());
globalThis.addEventListener?.('pagehide',()=>player.stopAll());
