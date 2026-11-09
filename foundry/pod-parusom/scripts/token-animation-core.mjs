/** Pure binding rules and a reversible, per-token texture playback queue. */
export const ID = 'pod-parusom';
export const tag = doc => doc?.flags?.[ID] ?? {};
export function profileOf(actor, index) {
  const f=tag(actor), key=f.profile ?? f.key;
  return index.profileAliases[key] ?? key;
}
export function clipAllowed(actor, clip, index) {
  return !!clip && clip.profile===profileOf(actor,index)
    && (!tag(actor).broken || clip.id==='12_03');
}
export function resolveClip(workflow, index) {
  if (!workflow || workflow.aborted || !workflow.item || !workflow.actor) return null;
  const item=workflow.item, f=tag(item);
  if (item.name?.startsWith('Мультиатака') || f.key?.includes(':Мультиатака')) return null;
  const requested=workflow.podParusomAnimationVariant ?? f.tokenAnimation ?? index.itemBindings[f.key];
  const clip=index.clips[requested];
  return clipAllowed(workflow.actor,clip,index) ? clip : null;
}

export class TokenAnimationPlayer {
  constructor({prepare, sceneId, now=Date.now, log=console.warn, maxQueue=6, maxAge=15000}) {
    Object.assign(this,{prepare,sceneId,now,log,maxQueue,maxAge}); this.states=new Map();
  }
  play(token,clip) {
    if (!token?.document?.uuid || !token.mesh || token.destroyed || token.isVisible===false) return Promise.resolve(false);
    const key=token.document.uuid;
    let state=this.states.get(key);
    if (!state) {
      state={token,queue:[],closed:false,controller:null,asset:null,snapshot:null};this.states.set(key,state);
    }
    if (state.queue.length>=this.maxQueue) return Promise.resolve(false);
    const result=new Promise(resolve=>state.queue.push({clip,resolve,created:this.now()}));
    if (!state.running) {state.running=true;void this._drain(key,state);}
    return result;
  }
  async _drain(key,state) {
    while (!state.closed && state.queue.length) {
      const job=state.queue.shift(); let result=false;
      if (this.now()-job.created<=this.maxAge) {
        try {result=await this._run(state,job.clip);} catch(e) {this.log('Парус · анимация',e);}
      }
      job.resolve(result);
    }
    for(const job of state.queue.splice(0))job.resolve(false);
    if(this.states.get(key)===state)this.states.delete(key);
  }
  async _run(state,clip) {
    const token=state.token, controller=new AbortController();state.controller=controller;
    const scene=this.sceneId(), originalSrc=token.document.texture?.src;
    try {
      state.asset=await this.prepare(clip,controller.signal);
      if(controller.signal.aborted || state.closed || token.destroyed || !token.mesh
        || this.sceneId()!==scene || token.isVisible===false || token.document.texture?.src!==originalSrc)return false;
      state.originalSrc=originalSrc;
      state.snapshot={texture:token.texture,meshTexture:token.mesh.texture};
      // Reuse Foundry's own mesh: rotation, fog, alpha, HUD and hit points remain native.
      token.texture=state.asset.texture;token.mesh.texture=state.asset.texture;
      await state.asset.play(controller.signal);
      return !controller.signal.aborted;
    } finally {
      this._restore(state);
      try {state.asset?.dispose();} catch(e) {this.log('Парус · освобождение видео',e);}
      state.asset=null;state.snapshot=null;state.controller=null;
    }
  }
  _restore(state) {
    const {token,asset,snapshot}=state;if(!asset||!snapshot)return;
    if(token.texture===asset.texture)token.texture=snapshot.texture??snapshot.meshTexture;
    if(token.mesh && !token.mesh.destroyed && token.mesh.texture===asset.texture) {
      token.mesh.texture=token.texture ?? snapshot.meshTexture;
      token.renderFlags?.set({refreshMesh:true});
    }
  }
  refresh(token) {
    const s=this.states.get(token?.document?.uuid);
    if(!s?.snapshot || !s.asset || s.controller?.signal.aborted)return;
    if(token.document.texture?.src!==s.originalSrc) {this.stop(token.document.uuid);return;}
    token.texture=s.asset.texture;if(token.mesh&&!token.mesh.destroyed)token.mesh.texture=s.asset.texture;
  }
  stop(key) {
    const state=this.states.get(key);if(!state)return;
    state.closed=true;state.controller?.abort();this._restore(state);
    for(const job of state.queue.splice(0))job.resolve(false);
    if(this.states.get(key)===state)this.states.delete(key);
  }
  stopAll() {for(const key of [...this.states.keys()])this.stop(key);}
}

export function acceptPacket(packet,index,{user,token,sceneId,now=Date.now()}) {
  if(packet?.type!=='tokenAnimation' || typeof packet.id!=='string' || packet.id.length>100
    || packet.sceneId!==sceneId || token?.document?.uuid!==packet.tokenUuid
    || !Number.isFinite(packet.createdAt) || Math.abs(now-packet.createdAt)>30000
    || !user?.active || (!user.isGM && !token?.actor?.testUserPermission?.(user,'OWNER')))return false;
  return clipAllowed(token.actor,index.clips[packet.clipId],index);
}

/** Artwork faces south at zero degrees, matching Foundry's token convention. */
export function facingAngle(source, target) {
  const a=source?.center,b=target?.center;
  if(!a||!b||![a.x,a.y,b.x,b.y].every(Number.isFinite))return null;
  const dx=b.x-a.x,dy=b.y-a.y;
  if(Math.hypot(dx,dy)<0.001)return null;
  return (Math.atan2(dy,dx)*180/Math.PI-90+360)%360;
}
export function firstFacingTarget(source, targets) {
  return [...(targets??[])].map(t=>t?.object??t).find(t=>!t?.destroyed
    && t?.document?.uuid!==source?.document?.uuid && facingAngle(source,t)!==null)??null;
}
// Legacy projectiles are superseded by the character's WebM clip.
export function targetEffectFile(kind) {
  return {heal:'heal.svg',melee:'slash.svg',burst:'burst.svg'}[kind]??null;
}
/** Serialize the turn and broadcast too, not just the receiving client's texture. */
export class TokenDispatchQueue {
  constructor(){this.pending=new Map();this.counts=new Map();}
  run(key,task) {
    const count=this.counts.get(key)??0;if(count>=7)return Promise.resolve(false);
    const created=Date.now();this.counts.set(key,count+1);
    const prior=this.pending.get(key)??Promise.resolve();
    const next=prior.catch(()=>{}).then(()=>Date.now()-created<=15000?task():false);
    this.pending.set(key,next);
    const clean=()=>{const n=(this.counts.get(key)??1)-1;if(n)this.counts.set(key,n);else this.counts.delete(key);if(this.pending.get(key)===next)this.pending.delete(key);};
    next.then(clean,clean);return next;
  }
}
