const MODULE_ID = "dobi-mik-adventure";
const IMPORT_MACRO = "Импорт приключения: Доби Мик";
const RESET_MACRO = "Лёгкие: сброс цикла";
const MAPS_MACRO = "Доби Мик: обновить карты и боевые действия";
const PANEL_MACRO = "Доби Мик: панель управления";
const WATER_RISE_PX = 120; // 20 ft при масштабе карты 30 px = 5 ft
const ENCOUNTERS = {
  deck: {name:"Бой с Доби Миком", sceneKey:"deck", roster:[{actorKey:"dobi-mik",count:1}]},
  lungs: {name:"Бой в лёгких", sceneKey:"lungs", roster:[{actorKey:"alveolar-hunter",count:2},{actorKey:"lung-leech",count:3}]},
  intestine: {name:"Бой в кислотном море желудка", sceneKey:"stomach", roster:[{actorKey:"intestinal-parasite",count:4}]}
};
// The GM action panel is the single damage-application path. Each target gets an independent attack roll;
// save outcomes are marked per target, then dnd5e applies typed damage with its resistance rules.
const MONSTER_ACTIONS = [
  {id:"whale-bite",actorKey:"dobi-mik",name:"Укус",kind:"attack",bonus:8,range:"10 фт.",damage:[{formula:"4d10 + 5",type:"piercing"}]},
  {id:"whale-tail",actorKey:"dobi-mik",name:"Хвост",kind:"attack",bonus:8,range:"15 фт.",damage:[{formula:"3d8 + 5",type:"bludgeoning"}],save:{ability:"str",dc:16,onFailStatus:"prone"}},
  {id:"whale-ram",actorKey:"dobi-mik",name:"Таран корпуса (перезарядка 5–6)",kind:"save",ability:"dex",dc:15,damage:[{formula:"3d8",type:"bludgeoning"}],halfOnSuccess:true,onFailStatus:"prone",splash:true,recharge:5},
  {id:"slime-strike",actorKey:"alveolar-hunter",name:"Удар",kind:"attack",bonus:5,range:"5 фт.",damage:[{formula:"2d8 + 3",type:"bludgeoning"},{formula:"1d6",type:"acid"}]},
  {id:"slime-engulf",actorKey:"alveolar-hunter",name:"Обволакивание (перезарядка 5–6)",kind:"save",ability:"dex",dc:13,damage:[],onFailStatus:"grappled",ongoing:{formula:"2d6",type:"acid",trigger:"targetStart",status:"grappled"},note:"При провале цель схвачена; 2к6 кислотного урона в начале её хода.",recharge:5},
  {id:"leech-bite",actorKey:"lung-leech",name:"Укус",kind:"attack",bonus:5,range:"5 фт.",damage:[{formula:"1d8 + 3",type:"piercing"}],onHitStatus:"grappled",ongoing:{formula:"1d6",type:"piercing",trigger:"sourceStart",status:"grappled",healSource:true},note:"Цель схвачена (СЛ высвобождения 13). В начале хода пиявки схваченная цель получает 1к6 колющего урона; пиявка восстанавливает столько же хитов."},
  {id:"parasite-multi",actorKey:"intestinal-parasite",name:"Мультиатака: два щупальца",kind:"multiattack",bonus:7,range:"10 фт.",strikes:2,damage:[{formula:"2d8 + 4",type:"bludgeoning"}],onHitStatus:"grappled",note:"Цель Большого размера или меньше схвачена (СЛ высвобождения 15)."},
  {id:"parasite-swallow",actorKey:"intestinal-parasite",name:"Проглотить схваченную цель (перезарядка 6)",kind:"save",ability:"dex",dc:15,damage:[],onFailStatus:"restrained",alsoStatuses:["blinded"],ongoing:{formula:"2d6",type:"acid",trigger:"sourceStart",status:"restrained"},note:"При провале цель проглочена: она ослеплена и обездвижена; 2к6 кислотного урона в начале хода паразита.",recharge:6},
  {id:"tortuga-harpoon",actorKey:"tortuga-support",name:"Гарпун",kind:"attack",bonus:6,range:"5 фт.",damage:[{formula:"1d10 + 4",type:"piercing"}]},
  {id:"tortuga-help",actorKey:"tortuga-support",name:"Помощь с кораблём или снастями",kind:"help",note:"Даёт преимущество на одну связанную с кораблём или снастями проверку союзника; не усиливает атаку по киту."}
];
const PHASES = [
  {name:"Вдох — альвеолы надуваются", image:"inflated", gif:"inflate.gif", text:"Соседние альвеолы почти соприкасаются: между ними можно перемещаться обычным движением."},
  {name:"Подъём воды на 20 футов", image:"inflated", waterRise:true, gif:"water-rise.gif", text:"Вода поднялась ещё на 20 футов и не отступает. Не закрепившиеся существа проходят спасбросок Силы СЛ 14; при провале их сносит на 20 футов."},
  {name:"Выдох — альвеолы сдуваются", image:"deflated", gif:"deflate.gif", text:"Вода остаётся на достигнутой высоте. Промежутки расширились: переход требует Атлетики или Акробатики СЛ 15 либо помощи союзника."}
];
const modulePath = (path) => `modules/${MODULE_ID}/${path}`;
function primaryGM() {
  const activeGM = game.users.activeGM ?? game.users.find(u => u.isGM && u.active);
  return game.user.isGM && (!activeGM || activeGM.id === game.user.id);
}
async function fetchContent() {
  const response = await fetch(modulePath("data/content.json"));
  if (!response.ok) throw new Error(`Не удалось прочитать данные модуля (${response.status}).`);
  return response.json();
}
async function folderFor(name, type) {
  return game.folders.find(f => f.name === name && f.type === type) ?? Folder.create({name,type,sorting:"a"});
}
function alreadyExists(collection, key) {
  return collection.find(d => d.getFlag(MODULE_ID, "sourceKey") === key);
}
function importedByModule(doc) {
  return Boolean(doc?.getFlag?.(MODULE_ID, "sourceKey"));
}
async function ensureLungWaterline(scene) {
  if (!scene?.getFlag(MODULE_ID,"lungsCycle")?.enabled) return;
  let tile=scene.tiles.find(t=>t.getFlag(MODULE_ID,"waterline"));
  const state=scene.getFlag(MODULE_ID,"lungsCycle") ?? {};
  const waterY=Math.max(0,Math.min(Number(state.waterY ?? state.baseWaterY ?? 914),scene.height));
  // Artwork's wave crest sits about 9% below its top edge; offset the tile so the crest tracks the saved water height.
  const y=Math.max(0,(waterY-scene.height*0.09)/0.91);
  const height=Math.max(1,scene.height-y);
  if (!tile) {
    const [created]=await scene.createEmbeddedDocuments("Tile", [{
      name:"Вода в лёгких",texture:{src:modulePath("assets/lungs/water-overlay.png"),fit:"fill"},x:0,y,width:scene.width,height,overhead:false,sort:1000,alpha:0.72,
      flags:{[MODULE_ID]:{waterline:true}}
    }]);
    tile=created;
  } else {
    await tile.update({name:"Вода в лёгких", "texture.src":modulePath("assets/lungs/water-overlay.png"),"texture.fit":"fill",x:0,y,width:scene.width,height,overhead:false,sort:1000,alpha:0.72});
  }
  if (state.waterlineTileId!==tile.id) await scene.setFlag(MODULE_ID,"lungsCycle",{...state,waterlineTileId:tile.id});
}
function primaryLevel(scene) {
  return scene?.initialLevel ?? scene?.levels?.contents?.[0] ?? scene?.levels?.values?.().next?.().value ?? null;
}
async function setSceneBackground(scene, src) {
  let level=primaryLevel(scene);
  if (!level) {
    const [created]=await scene.createEmbeddedDocuments("Level", [{
      name:"Основной уровень",elevation:{bottom:0,top:10},background:{src}
    }]);
    if (!created) throw new Error(`Не удалось создать уровень с картой для сцены «${scene.name}».`);
    level=created;
    if (!scene.initialLevel) await scene.update({initialLevel:level.id});
    return level;
  }
  await level.update({"background.src":src});
  return level;
}
async function synchronizeImportedActors(actorData) {
  let patched=0, missing=0;
  for (const source of actorData) {
    const actor=alreadyExists(game.actors,source.flags?.[MODULE_ID]?.sourceKey);
    if (!actor) continue;
    for (const sourceItem of source.items ?? []) {
      const activities=sourceItem.system?.activities;
      if (!activities || !Object.keys(activities).length) continue;
      const item=actor.items.find(i=>i.name===sourceItem.name);
      if (!item) { missing++; continue; }
      const updates={};
      for (const [id,activity] of Object.entries(activities)) updates[`system.activities.${id}`]=activity;
      updates[`flags.${MODULE_ID}.sourceKey`]=sourceItem.flags?.[MODULE_ID]?.sourceKey ?? `${source.flags?.[MODULE_ID]?.sourceKey}:${sourceItem.name}`;
      await item.update(updates);
      patched++;
    }
  }
  return {patched,missing};
}
async function synchronizeImportedScenes(sceneData) {
  let repaired=0, skipped=0;
  for (const source of sceneData) {
    const key=source.flags?.[MODULE_ID]?.sourceKey;
    // Adventure import can drop flags; recover the intended scene by its stable name.
    const scene=alreadyExists(game.scenes,key) ?? game.scenes.find(d=>d.name===source.name);
    if (!scene) continue;
    const src=source.background?.src;
    if (!src) { skipped++; continue; }
    const incomingCycle=source.flags?.[MODULE_ID]?.lungsCycle;
    const currentCycle=scene.getFlag(MODULE_ID,"lungsCycle") ?? {};
    const activeCycle=Boolean(incomingCycle?.enabled && (Number(currentCycle.lastRound)>0 || currentCycle.combatId));
    const sceneSrc=activeCycle
      ? modulePath(`assets/maps/lungs_${PHASES[Number(currentCycle.phase)||0].image}.jpg`)
      : src;
    await setSceneBackground(scene,sceneSrc);
    const updates={[`flags.${MODULE_ID}.sourceKey`]:key};
    if(incomingCycle) updates[`flags.${MODULE_ID}.lungsCycle`]={...incomingCycle,...currentCycle};
    await scene.update(updates);
    await ensureLungWaterline(scene);
    repaired++;
  }
  return {repaired,skipped};
}
async function importAdventure() {
  if (!game.user.isGM) return ui.notifications.error("Импорт доступен только ведущему.");
  const proceed = await foundry.applications.api.DialogV2.confirm({
    window:{title:"Импорт и обновление приключения «Доби Мик»"},
    content:"Создать недостающие сцены, актёров и журнал, а также восстановить карты и боевые Activities в документах приключения, уже импортированных в мир? Пользовательские характеристики актёров и содержимое журналов сохраняются.",
    rejectClose:false,modal:true
  });
  if (!proceed) return;
  const content = await fetchContent();
  const actorFolder = await folderFor("Доби Мик — существа", "Actor");
  const sceneFolder = await folderFor("Доби Мик — сцены", "Scene");
  const journalFolder = await folderFor("Доби Мик — журнал", "JournalEntry");
  let created={actors:0,scenes:0,journals:0};
  const actorData=content.actors.filter(d=>!alreadyExists(game.actors,d.flags?.[MODULE_ID]?.sourceKey)).map(d=>({...d,folder:actorFolder.id}));
  if(actorData.length) created.actors=(await Actor.createDocuments(actorData)).length;
  const journalData=content.journals.filter(d=>!alreadyExists(game.journal,d.flags?.[MODULE_ID]?.sourceKey)).map(d=>({...d,folder:journalFolder.id}));
  if(journalData.length) created.journals=(await JournalEntry.createDocuments(journalData)).length;
  const sceneData=content.scenes.filter(d=>!alreadyExists(game.scenes,d.flags?.[MODULE_ID]?.sourceKey)).map(d=>{
    const {background,...scene}=d;
    return {...scene,folder:sceneFolder.id};
  });
  if(sceneData.length) created.scenes=(await Scene.createDocuments(sceneData)).length;
  const actorSync=await synchronizeImportedActors(content.actors);
  const sceneSync=await synchronizeImportedScenes(content.scenes);
  ui.notifications.info(`«Доби Мик»: создано сцен ${created.scenes}, актёров ${created.actors}, записей ${created.journals}; обновлено карт ${sceneSync.repaired}, предметов с Activities ${actorSync.patched}.`);
  if (sceneSync.skipped || actorSync.missing) ui.notifications.warn(`Не найдено: сцен ${sceneSync.skipped}, предметов атак ${actorSync.missing}. Проверьте папки «Доби Мик».`);
}
function showTransition(gif) {
  const board=document.querySelector("#board");
  if(!board) return;
  board.querySelector("#dobi-lungs-transition")?.remove();
  const img=document.createElement("img"); img.id="dobi-lungs-transition"; img.src=modulePath(`assets/lungs/${gif}?v=1.1.0&t=${Date.now()}`); img.alt="Смена фазы лёгких";
  img.onload=()=>{ img.dataset.loaded="true"; };
  board.append(img);
  window.setTimeout(()=>img.remove(),650);
}
function currentLungScene(combat) {
  const scene=canvas?.scene;
  if(!scene || !scene.getFlag(MODULE_ID,"lungsCycle")?.enabled) return null;
  if(combat?.sceneId && combat.sceneId!==scene.id) return null;
  return scene;
}
async function setLungRound(combat, round) {
  const scene=currentLungScene(combat);
  if(!scene || round<1) return;
  const stored=scene.getFlag(MODULE_ID,"lungsCycle") ?? {};
  const combatId=combat?.id ?? "active";
  if(stored.combatId===combatId && Number(stored.lastRound)===Number(round)) return;
  const sameCombat=stored.combatId===combatId;
  const roundOffset=sameCombat ? Number(stored.roundOffset)||0 : 0;
  const cycleRound=Math.max(1,Number(round)-roundOffset);
  const phase=PHASES[(cycleRound-1)%3];
  const imagePath=modulePath(`assets/maps/lungs_${phase.image}.jpg`);
  if(primaryGM()) {
    const rises=Math.floor((cycleRound+1)/3);
    const baseY=Number(stored.baseWaterY ?? 914);
    const waterY=Math.max(0,baseY-rises*WATER_RISE_PX);
    await setSceneBackground(scene,imagePath);
    await scene.update({[`flags.${MODULE_ID}.lungsCycle`]:{...stored,enabled:true,combatId,lastRound:Number(round),cycleRound,roundOffset,phase:Number(cycleRound-1)%3,baseWaterY:baseY,waterRiseCount:rises,waterY}});
    await ensureLungWaterline(scene);
  }
  const stamp=`${combatId}:${round}`;
  window.__dobiLungsShown ??= new Set();
  if(!window.__dobiLungsShown.has(stamp)) {
    window.__dobiLungsShown.add(stamp);
    showTransition(phase.gif);
    ui.notifications.info(`Лёгкие — раунд ${round}: ${phase.name}. ${phase.text}`);
  }
}
async function resetLungs() {
  if(!game.user.isGM) return ui.notifications.error("Сброс доступен только ведущему.");
  const scene=canvas?.scene;
  const state=scene?.getFlag(MODULE_ID,"lungsCycle");
  if(!state?.enabled) return ui.notifications.warn("Активная сцена не является сценой лёгких.");
  await setSceneBackground(scene,modulePath("assets/maps/lungs_inflated.jpg"));
  const combat=game.combat?.scene?.id===scene.id ? game.combat : null;
  const currentRound=Number(combat?.round)||0;
  await scene.update({[`flags.${MODULE_ID}.lungsCycle`]:{...state,lastRound:currentRound,combatId:combat?.id ?? null,roundOffset:Math.max(0,currentRound-1),cycleRound:1,phase:0,waterRiseCount:0,waterY:state.baseWaterY ?? 914}});
  await ensureLungWaterline(scene);
  ui.notifications.info("Цикл лёгких сброшен: альвеолы надуты, вода внизу.");
}
async function rewindLungCycle() {
  if(!game.user.isGM) return ui.notifications.error("Откат доступен только ведущему.");
  const scene=canvas?.scene;
  const state=scene?.getFlag(MODULE_ID,"lungsCycle");
  if(!state?.enabled) return ui.notifications.warn("Активная сцена не является сценой лёгких.");
  const combat=game.combat?.scene?.id===scene.id ? game.combat : null;
  if(combat && Number(combat.round)>1) {
    await combat.previousRound();
    await setLungRound(combat,Number(combat.round)||1);
    ui.notifications.info("Цикл лёгких откачен на один раунд.");
    return;
  }
  const previous=Math.max(1,(Number(state.cycleRound)||Number(state.lastRound)||1)-1);
  const rises=Math.floor((previous+1)/3);
  const waterY=Math.max(0,Number(state.baseWaterY ?? 914)-rises*WATER_RISE_PX);
  const phase=PHASES[(previous-1)%3];
  await setSceneBackground(scene,modulePath(`assets/maps/lungs_${phase.image}.jpg`));
  await scene.update({[`flags.${MODULE_ID}.lungsCycle`]:{...state,lastRound:previous,cycleRound:previous,roundOffset:0,phase:(previous-1)%3,waterRiseCount:rises,waterY}});
  await ensureLungWaterline(scene);
  ui.notifications.info("Цикл лёгких откачен на один раунд.");
}
function sceneByKey(key) {
  return game.scenes.find(scene=>scene.getFlag(MODULE_ID,"sourceKey")===key);
}
async function startEncounter(encounterKey) {
  if(!game.user.isGM) return ui.notifications.error("Бои может запускать только ведущий.");
  const encounter=ENCOUNTERS[encounterKey];
  if(!encounter) return ui.notifications.error("Неизвестное столкновение.");
  const scene=sceneByKey(encounter.sceneKey);
  if(!scene) return ui.notifications.error(`Не найдена сцена для боя «${encounter.name}». Сначала обновите приключение.`);
  const roster=encounter.roster.flatMap(entry=>Array.from({length:entry.count},(_,index)=>({actorKey:entry.actorKey,index:index+1})));
  const actors=roster.map(row=>({row,actor:game.actors.find(actor=>actor.getFlag(MODULE_ID,"sourceKey")===row.actorKey)}));
  if(actors.some(item=>!item.actor)) return ui.notifications.error(`Не все участники боя «${encounter.name}» импортированы. Обновите приключение.`);
  await scene.view();
  const combat=game.combats.find(item=>item.scene?.id===scene.id && item.getFlag(MODULE_ID,"encounterKey")===encounterKey)
    ?? await Combat.create({name:encounter.name,scene:scene.id,round:1,turn:0,flags:{[MODULE_ID]:{encounterKey}}});
  const tokenDocs=[];
  let index=0;
  for(const {row,actor} of actors) {
    const tokenKey=`${encounterKey}:${row.actorKey}:${row.index}`;
    let token=scene.tokens.find(item=>item.getFlag(MODULE_ID,"encounterToken")===tokenKey);
    if(!token) {
      const {_id:ignoredTokenId,...proto}=actor.prototypeToken.toObject();
      const [created]=await scene.createEmbeddedDocuments("Token",[{
        ...proto,name:row.index>1?`${actor.name} ${row.index}`:actor.name,actorId:actor.id,actorLink:false,
        x:scene.width+300+index*scene.grid.size*4,y:scene.height+300,
        hidden:false,disposition:row.actorKey==="tortuga-support"?CONST.TOKEN_DISPOSITIONS.FRIENDLY:CONST.TOKEN_DISPOSITIONS.HOSTILE,
        flags:{...proto.flags,[MODULE_ID]:{...(proto.flags?.[MODULE_ID]??{}),encounterToken:tokenKey}}
      }]);
      token=created;
    }
    if(token) tokenDocs.push(token);
    index++;
  }
  const additions=tokenDocs.filter(token=>!combat.combatants.some(combatant=>combatant.tokenId===token.id));
  const created=additions.length ? await TokenDocument.createCombatants(additions,{combat}) : [];
  const encounterCombatants=combat.combatants.filter(combatant=>tokenDocs.some(token=>combatant.tokenId===token.id));
  const hiddenCombatants=encounterCombatants.filter(combatant=>combatant.hidden);
  if(hiddenCombatants.length) await combat.updateEmbeddedDocuments("Combatant",hiddenCombatants.map(combatant=>({_id:combatant.id,hidden:false})));
  const unrolled=encounterCombatants.filter(combatant=>combatant.initiative===null);
  if(unrolled.length) await combat.rollInitiative(unrolled.map(combatant=>combatant.id));
  await combat.activate();
  ui.notifications.info(`«${encounter.name}»: в инициативе ${encounterCombatants.length} участников. Токены противников скрыты за границей карты; ведущий может вывести их на карту вручную.`);
}
function selectedTargets() {
  return Array.from(game.user.targets ?? []).filter(token=>token?.actor && token.actor.system?.attributes?.hp);
}
function criticalFormula(formula) {
  return formula.replace(/(\d*)d(\d+)/gi,(_match,count,sides)=>`${(Number(count)||1)*2}d${sides}`);
}
async function rollAndAnnounce(formula,sourceActor,flavor) {
  const roll=await (new Roll(formula,sourceActor?.getRollData?.()??{})).evaluate({async:true});
  await roll.toMessage({speaker:ChatMessage.getSpeaker({actor:sourceActor}),flavor});
  return roll;
}
async function applyRolledDamage(token,damageParts,multiplier=1,critical=false,sourceActor=null) {
  const parts=[];
  for(const part of damageParts) {
    const formula=critical?criticalFormula(part.formula):part.formula;
    const roll=await rollAndAnnounce(formula,sourceActor,`${part.type} урон → ${token.name}`);
    parts.push({value:roll.total,type:part.type});
  }
  if(parts.length) await token.actor.applyDamage(parts,{multiplier});
}
async function addCondition(token,status) {
  try { await token.actor.toggleStatusEffect(status,{active:true}); }
  catch(error) { console.warn(`${MODULE_ID} | Не удалось применить состояние ${status}`,error); }
}
async function registerOngoingDamage(token,ongoing,sourceActor,actionId) {
  if(!ongoing || !token?.document) return;
  const sourceToken=sourceTokenForActor(sourceActor);
  const current=token.document.getFlag(MODULE_ID,"ongoingMonsterEffects") ?? [];
  const effects=current.filter(effect=>effect.actionId!==actionId);
  effects.push({...ongoing,actionId,sourceTokenId:sourceToken?.id ?? null,sourceKey:sourceActor.getFlag(MODULE_ID,"sourceKey")});
  await token.document.setFlag(MODULE_ID,"ongoingMonsterEffects",effects);
}
async function processOngoingMonsterDamage(combat) {
  if(!primaryGM()) return;
  const active=combat.combatant;
  const activeTokenId=active?.tokenId;
  if(!activeTokenId) return;
  for(const combatant of combat.combatants) {
    const target=combatant.token?.document ?? combatant.token;
    if(!target) continue;
    const actor=target.actor ?? combatant.actor;
    if(!actor) continue;
    const effects=target.getFlag(MODULE_ID,"ongoingMonsterEffects") ?? [];
    if(!effects.length) continue;
    const keep=[];
    for(const effect of effects) {
      const activeStatus=actor.statuses?.has(effect.status);
      if(!activeStatus) continue;
      const tick=(effect.trigger==="targetStart" && target.id===activeTokenId)
        || (effect.trigger==="sourceStart" && effect.sourceTokenId===activeTokenId);
      if(!tick) { keep.push(effect); continue; }
      const roll=await rollAndAnnounce(effect.formula,actor,`${effect.type} урон от эффекта монстра → ${target.name}`);
      await actor.applyDamage([{value:roll.total,type:effect.type}]);
      if(effect.healSource) {
        const sourceCombatant=combat.combatants.find(c=>c.tokenId===effect.sourceTokenId);
        const source=sourceCombatant?.token?.document ?? sourceCombatant?.token;
        const sourceActor=source?.actor ?? sourceCombatant?.actor;
        if(sourceActor) {
          const hp=sourceActor.system.attributes.hp;
          await sourceActor.update({"system.attributes.hp.value":Math.min(hp.max,hp.value+roll.total)});
        }
      }
      await ChatMessage.create({content:`<p>${target.name} получает ${roll.total} ${effect.type} урона в начале хода.</p>`});
      keep.push(effect);
    }
    await target.setFlag(MODULE_ID,"ongoingMonsterEffects",keep);
  }
}
function sourceTokenForActor(actor) {
  const combatant=game.combat?.combatant;
  if(combatant?.actorId===actor.id && combatant.token) return combatant.token.document ?? combatant.token;
  return canvas?.scene?.tokens?.find(token=>token.actorId===actor.id) ?? null;
}
async function rechargeReady(action,sourceActor) {
  if(!action.recharge) return true;
  const token=sourceTokenForActor(sourceActor);
  const state=token?.getFlag(MODULE_ID,"recharge") ?? {};
  if(!state[action.id]) return true;
  const roll=await rollAndAnnounce("1d6",sourceActor,`${action.name}: проверка перезарядки`);
  if(roll.total<action.recharge) {
    ui.notifications.warn(`${action.name}: перезарядка не удалась; действие недоступно.`);
    return false;
  }
  if(token) await token.setFlag(MODULE_ID,"recharge",{...state,[action.id]:false});
  return true;
}
function saveOutcomeDialog(action,token,sourceActor,damageParts) {
  return new Promise(resolve=>{
    let finished=false;
    const close=()=>{ if(!finished){finished=true;resolve(false);} };
    const handle=async passed=>{
      if(finished) return;
      finished=true;
      const multiplier=passed?(action.halfOnSuccess?0.5:0):1;
      if(damageParts.length && multiplier>0) await applyRolledDamage(token,damageParts,multiplier,false,sourceActor);
      if(!passed && action.onFailStatus) await addCondition(token,action.onFailStatus);
      if(!passed) for(const status of action.alsoStatuses??[]) await addCondition(token,status);
      if(!passed && action.ongoing) await registerOngoingDamage(token,action.ongoing,sourceActor,action.id);
      await ChatMessage.create({speaker:ChatMessage.getSpeaker({actor:sourceActor}),content:`<p><strong>${action.name}</strong> — ${token.name}: спасбросок ${passed?"пройден":"не пройден"}${damageParts.length?`, урон применён (${passed?(action.halfOnSuccess?"половина":"нет урона") : "полный"})`:""}.${!passed&&action.note?` ${action.note}`:""}</p>`});
      resolve(true);
    };
    const dialog=new Dialog({
      title:`${action.name}: ${token.name}`,
      content:`<p><strong>${token.name}</strong> — спасбросок ${CONFIG.DND5E.abilities[action.ability]?.label??action.ability.toUpperCase()} СЛ ${action.dc}.</p><p>${action.note??"Отметьте результат спасброска."}</p>`,
      buttons:{passed:{label:"Спасбросок пройден",callback:()=>handle(true)},failed:{label:"Спасбросок не пройден",callback:()=>handle(false)}},
      default:"passed",close
    });
    dialog.render(true);
  });
}
async function runMonsterAction(actionId) {
  if(!game.user.isGM) return ui.notifications.error("Автоматические действия доступны ведущему.");
  const action=MONSTER_ACTIONS.find(row=>row.id===actionId);
  if(!action) return ui.notifications.error("Действие не найдено.");
  const sourceActor=game.actors.find(actor=>actor.getFlag(MODULE_ID,"sourceKey")===action.actorKey);
  if(!sourceActor) return ui.notifications.error("Актёр не импортирован. Обновите приключение.");
  const targets=selectedTargets();
  if(!targets.length) return ui.notifications.warn("Сначала отметьте цели токенами Foundry (клавиша T), затем нажмите действие в панели.");
  if(!await rechargeReady(action,sourceActor)) return;
  if(action.kind==="help") {
    const recipients=targets.filter(token=>token.document.disposition!==CONST.TOKEN_DISPOSITIONS.HOSTILE);
    if(!recipients.length) return ui.notifications.warn("Для Помощи выберите токен союзника.");
    await ChatMessage.create({speaker:ChatMessage.getSpeaker({actor:sourceActor}),content:`<p><strong>Тортуга помогает:</strong> ${recipients.map(t=>t.name).join(", ")} получает преимущество на следующую проверку, связанную с кораблём или снастями. Помощь не даёт преимущества на атаку по киту.</p>`});
    ui.notifications.info("Помощь Тортуги отмечена в чате; примените преимущество к следующей подходящей проверке.");
    return;
  }
  if(action.kind==="save") {
    let resolved=false;
    for(const token of targets) resolved=await saveOutcomeDialog(action,token,sourceActor,action.damage) || resolved;
    if(resolved && action.recharge) {
      const token=sourceTokenForActor(sourceActor);
      if(token) {
        const state=token.getFlag(MODULE_ID,"recharge") ?? {};
        await token.setFlag(MODULE_ID,"recharge",{...state,[action.id]:true});
      }
    }
    return;
  }
  const strikes=action.kind==="multiattack"?action.strikes:1;
  for(const token of targets) {
    for(let strike=1;strike<=strikes;strike++) {
      const label=strikes>1?`${action.name} (${strike}/${strikes})`:action.name;
      const attack=await rollAndAnnounce(`1d20 + ${action.bonus}`,sourceActor,`${label} → ${token.name} (КД ${token.actor.system.attributes.ac.value})`);
      const d20=attack.dice?.[0]?.results?.[0]?.result;
      const critical=d20===20;
      const hit=critical || (d20!==1 && attack.total>=Number(token.actor.system.attributes.ac.value||10));
      if(!hit) {
        await ChatMessage.create({speaker:ChatMessage.getSpeaker({actor:sourceActor}),content:`<p><strong>${label}</strong> промахивается по ${token.name}.</p>`});
        continue;
      }
      await applyRolledDamage(token,action.damage,1,critical,sourceActor);
      if(action.onHitStatus) await addCondition(token,action.onHitStatus);
      if(action.ongoing) await registerOngoingDamage(token,action.ongoing,sourceActor,action.id);
      await ChatMessage.create({speaker:ChatMessage.getSpeaker({actor:sourceActor}),content:`<p><strong>${label}</strong> попадает по ${token.name}${critical?" критическим попаданием":""}.</p>`});
      if(action.save) {
        await saveOutcomeDialog({...action,...action.save,name:`${action.name}: дополнительный эффект`,damage:[]},token,sourceActor,[]);
      }
    }
  }
}
function actionButtons() {
  const groups=new Map();
  for(const action of MONSTER_ACTIONS) {
    const actor=game.actors.find(item=>item.getFlag(MODULE_ID,"sourceKey")===action.actorKey);
    const group=groups.get(action.actorKey)??{name:actor?.name??action.actorKey,actions:[]};
    group.actions.push(action); groups.set(action.actorKey,group);
  }
  return Array.from(groups.values()).map(group=>`<div class="dobi-panel-label">${group.name}</div>${group.actions.map(action=>`<button type="button" data-auto-action="${action.id}">${action.name}</button>`).join("")}`).join("");
}
function renderControlPanel() {
  document.querySelector("#dobi-mik-control-panel")?.remove();
  if(!game.user.isGM || !canvas?.scene) return;
  const panel=document.createElement("section");
  panel.id="dobi-mik-control-panel";
  const isLungs=canvas.scene.getFlag(MODULE_ID,"sourceKey")==="lungs";
  panel.innerHTML=`<header><strong>Доби Мик</strong><button type="button" data-action="collapse" aria-label="Свернуть">−</button></header><div class="dobi-panel-body"><div class="dobi-panel-label">Цикл лёгких</div><button type="button" data-action="reset" ${isLungs?"":"disabled"}>Обнулить цикл</button><button type="button" data-action="rewind" ${isLungs?"":"disabled"}>На шаг назад</button><div class="dobi-panel-label">Запустить бой</div>${Object.entries(ENCOUNTERS).map(([key,encounter])=>`<button type="button" data-encounter="${key}">${encounter.name}</button>`).join("")}<div class="dobi-panel-label">Действия по отмеченным целям</div><small>Выберите один или несколько токенов клавишей T. Урон применяется автоматически с учётом сопротивлений.</small>${actionButtons()}</div>`;
  panel.addEventListener("click",event=>{
    const button=event.target.closest("button"); if(!button) return;
    if(button.dataset.action==="collapse") { panel.classList.toggle("collapsed"); return; }
    const action=button.dataset.action;
    const task=action==="reset" ? resetLungs() : action==="rewind" ? rewindLungCycle() : button.dataset.encounter ? startEncounter(button.dataset.encounter) : button.dataset.autoAction ? runMonsterAction(button.dataset.autoAction) : null;
    if(task) void task.catch(error=>{console.error(`${MODULE_ID} | Ошибка панели управления`,error);ui.notifications.error(error.message??"Не удалось выполнить действие панели.");});
  });
  document.body.append(panel);
}
function toggleControlPanel() {
  if(!game.user.isGM) return ui.notifications.error("Панель доступна только ведущему.");
  const current=document.querySelector("#dobi-mik-control-panel");
  if(current) { current.remove(); return; }
  if(!canvas?.scene) return ui.notifications.warn("Сначала открой сцену, затем запусти макрос панели.");
  renderControlPanel();
}
async function ensureMacro(name,command,img) {
  if(game.macros.some(m=>m.name===name)) return;
  await Macro.create({name,type:"script",img,scope:"global",command,ownership:{default:0}});
}
Hooks.once("ready", async()=>{
  const mod=game.modules.get(MODULE_ID); if(!mod) return;
  mod.api={importAdventure,resetLungs,rewindLungCycle,startEncounter,toggleControlPanel};
  if(!game.user.isGM) return;
  try {
    await ensureMacro(IMPORT_MACRO,`await game.modules.get("${MODULE_ID}").api.importAdventure();`,"icons/svg/book.svg");
    await ensureMacro(RESET_MACRO,`await game.modules.get("${MODULE_ID}").api.resetLungs();`,"icons/svg/refresh.svg");
    await ensureMacro(MAPS_MACRO,`await game.modules.get("${MODULE_ID}").api.importAdventure();`,"icons/svg/map.svg");
    await ensureMacro(PANEL_MACRO,`await game.modules.get("${MODULE_ID}").api.toggleControlPanel();`,"icons/svg/target.svg");
    ui.notifications.info(`Макрос «${PANEL_MACRO}» открывает и закрывает панель управления сценами.`);
  } catch(err) { console.error(`${MODULE_ID} | Не удалось создать макросы`,err); }
});
Hooks.on("updateCombat",(combat,changes)=>{
  if(!("round" in changes || "turn" in changes)) return;
  window.setTimeout(()=>setLungRound(combat,Number(combat.round)||1),80);
});
Hooks.on("updateCombat",(combat,changes)=>{
  if(!("round" in changes || "turn" in changes)) return;
  const stamp=`${combat.id}:${combat.round}:${combat.turn}:${combat.combatantId}`;
  window.__dobiMonsterTicks ??= new Set();
  if(window.__dobiMonsterTicks.has(stamp)) return;
  window.__dobiMonsterTicks.add(stamp);
  window.setTimeout(()=>processOngoingMonsterDamage(combat).catch(error=>console.error(`${MODULE_ID} | Ошибка периодического урона`,error)),100);
});
Hooks.on("combatTurnChange",(combat,prior,current)=>setLungRound(combat,Number(current?.round ?? combat.round)||1));
Hooks.on("combatStart",(combat)=>setLungRound(combat,Number(combat.round)||1));
async function endLungCombat(combat) {
  if(!primaryGM()) return;
  const scene=currentLungScene(combat); if(!scene) return;
  const state=scene.getFlag(MODULE_ID,"lungsCycle");
  if(state?.combatId!==combat.id) return;
  await setSceneBackground(scene,modulePath("assets/maps/lungs_inflated.jpg"));
  await scene.update({[`flags.${MODULE_ID}.lungsCycle`]:{...state,lastRound:0,combatId:null,phase:0,waterRiseCount:0,waterY:state.baseWaterY ?? 914}});
  await ensureLungWaterline(scene);
}
Hooks.on("deleteCombat",endLungCombat);
Hooks.on("updateCombat",(combat,changes)=>{if(changes.active===false || changes.round===0) void endLungCombat(combat);});
