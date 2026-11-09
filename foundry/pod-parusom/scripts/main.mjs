import {targetEffectFile} from './token-animation-core.mjs';
const ID = "pod-parusom";
const BASE = `modules/${ID}/`;
const clone = value => foundry.utils.deepClone(value);
const tag = document => document?.flags?.[ID] ?? {};
const escape = text => String(text ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const gm = () => game.user.isGM;
const primary = () => gm() && game.users.activeGM?.id === game.user.id;
const notify = text => ui.notifications.info(text);
const err = text => {ui.notifications.warn(text); return null;};
let contentPromise, importing = false;
const content = () => contentPromise ??= fetch(BASE + "data/content.json").then(r => {if (!r.ok) throw Error(`Файлы модуля: HTTP ${r.status}`); return r.json();});
const findActor = key => game.actors.find(a => tag(a).key === key);
const selected = () => canvas.tokens?.controlled?.[0];
const targets = () => [...game.user.targets];
const tokenOf = actor => actor?.token?.object ?? actor?.getActiveTokens?.()[0];
const stamp = () => game.combat ? `${game.combat.id}:${game.combat.round}:${game.combat.turn}` : null;
const distance = (a,b) => Math.hypot(a.center.x-b.center.x,a.center.y-b.center.y) / canvas.grid.size * canvas.scene.grid.distance;
function canAct(a) {return a && a.system.attributes.hp.value > 0 && !["incapacitated","unconscious","stunned","paralyzed","petrified"].some(s => a.statuses?.has(s));}
async function say(text) {return ChatMessage.create({content:`<div class="pod-parusom"><p>${text}</p></div>`,whisper:ChatMessage.getWhisperRecipients("GM").map(u=>u.id)});}
async function choose(title, options, label="Выбрать") {
  if (!options.length) return null;
  return foundry.applications.api.DialogV2.prompt({window:{title},content:`<select name="choice">${options.map(([k,v])=>`<option value="${escape(k)}">${escape(v)}</option>`).join("")}</select>`,ok:{label,callback:(_event,button)=>button.form.elements.choice.value},rejectClose:false});
}
async function confirm(title, text) {return foundry.applications.api.DialogV2.confirm({window:{title},content:`<p>${escape(text)}</p>`,rejectClose:false});}
async function actorChoice() {
  if (selected()?.actor && tag(selected().actor).key) return selected().actor;
  const actors = canvas.tokens.placeables.map(t=>t.actor).filter(a=>tag(a).key);
  const id = await choose("Выберите актёра", actors.map(a=>[a.uuid,a.name]));
  return id ? fromUuid(id) : null;
}
function firstActivity(item) {return item.system.activities?.values().next().value;}
async function useItem(item, extra={}) {
  if (!item) return err("Способность не найдена.");
  const act = firstActivity(item);
  if (!act) return item.displayCard();
  if (game.modules.get("midi-qol")?.active && globalThis.MidiQOL?.completeActivityUse) {
    return MidiQOL.completeActivityUse(act.uuid, {midiOptions:{targetUuids:targets().map(t=>t.document.uuid),...extra}}, {configure:true}, {systemCard:false});
  }
  return act.use({}, {configure:true});
}
async function folder(type) {
  return game.folders.find(f=>f.type===type && f.flags?.[ID]?.key===type) ?? Folder.create({name:"Под парусом на костылях",type,color:"#792e2b",flags:{[ID]:{key:type}}});
}
function rewrite(value, ids) {
  if (typeof value === "string") {for (const [oldId,newId] of ids) value=value.replaceAll(oldId,newId); return value;}
  if (Array.isArray(value)) return value.map(v=>rewrite(v,ids));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v,ids)]));
  return value;
}
async function importAdventure() {
  if (!gm() || importing) return;
  if (game.system.id!=="dnd5e" || game.system.version!=="6.0.6") return err("Эта сборка рассчитана на dnd5e 6.0.6. Откройте диагностику; импорт остановлен до согласования версии.");
  importing=true;
  try {
    const data=await content(), ids=new Map(), created={actors:0,scenes:0,journal:0,macros:0,tables:0};
    for (const [key,Type,collection] of [["actors",Actor,game.actors],["scenes",Scene,game.scenes],["journal",JournalEntry,game.journal],["macros",Macro,game.macros],["tables",RollTable,game.tables]]) {
      const f=await folder(Type.documentName);
      for (const original of data[key]) {
        const existing=collection.find(d=>tag(d).key===tag(original).key);
        if (existing) {ids.set(original._id,existing.id);continue;}
        let d=rewrite(clone(original),ids);d.folder=f.id;
        if (collection.has(d._id)) d._id=foundry.utils.randomID();
        const doc=await Type.create(d,{keepId:true});ids.set(original._id,doc.id);created[key]++;
      }
    }
    await initializePiero();
    await game.modules.get(ID).api.upgradeFinales?.({silent:true});
    await configureAutomation();
    await game.settings.set(ID,"importedVersion","1.2.0");
    notify(`Импорт завершён: ${created.actors} актёров, ${created.scenes} сцен. Уже существующие документы сохранены.`);
    return diagnostics();
  } catch(e) {console.error(ID,e);err("Импорт прерван: "+e.message+". Повторный импорт продолжит работу без сброса уже созданных актёров.");}
  finally {importing=false;}
}
async function configureAutomation() {
  if (!gm() || !game.modules.get("midi-qol")?.active) return false;
  const key="midi-qol.ConfigSettings";
  if (!game.settings.settings.has(key)) return false;
  const old=clone(game.settings.get("midi-qol","ConfigSettings"));
  if (!Object.keys(game.settings.get(ID,"midiBackup")).length) await game.settings.set(ID,"midiBackup",old);
  const next={...old,allowUseMacro:true,allowActorUseMacro:true,autoRollAttack:true,gmAutoAttack:true,autoRollDamage:"onHit",gmAutoDamage:"onHit",autoCheckHit:"all",autoCheckSaves:"allShow",autoApplyDamage:"yesCard",autoItemEffects:"applyRemove",autoTarget:"wallsBlock",rollNPCSaves:"auto",playerRollSaves:"none"};
  await game.settings.set("midi-qol","ConfigSettings",next);
  if(game.settings.settings.has("dnd5e.autoRecharge")) {
    if(game.settings.get(ID,"rechargeBackup")==="")await game.settings.set(ID,"rechargeBackup",game.settings.get("dnd5e","autoRecharge"));
    await game.settings.set("dnd5e","autoRecharge","yes");
  }
  if (game.settings.settings.has("midi-qol.EnableWorkflow")) await game.settings.set("midi-qol","EnableWorkflow",true);
  return true;
}
async function restoreAutomation() {
  const backup=game.settings.get(ID,"midiBackup");
  if (Object.keys(backup).length && gm()) {
    await game.settings.set("midi-qol","ConfigSettings",backup);
    const recharge=game.settings.get(ID,"rechargeBackup");if(recharge!=="")await game.settings.set("dnd5e","autoRecharge",recharge);
    notify("Предыдущие настройки Midi-QOL и перезарядки восстановлены.");
  }
}
async function diagnostics() {
  const rows=[["Foundry",game.version,"14.369"],["dnd5e",game.system.version,"6.0.6"],...["midi-qol","dae","lib-wrapper","socketlib","sequencer","autoanimations"].map(id=>{const m=game.modules.get(id);return [id,m?.active?m.version:"не включён",id==="midi-qol"?"14.6.0 · ветка для dnd5e 6":"совместимая с Foundry 14 версия"];})];
  const cfg=game.modules.get("midi-qol")?.active && game.settings.settings.has("midi-qol.ConfigSettings")?game.settings.get("midi-qol","ConfigSettings"):{};
  const report={date:new Date().toISOString(),foundry:game.version,system:{id:game.system.id,version:game.system.version},modules:rows.slice(2),settings:Object.fromEntries(["autoRollAttack","gmAutoAttack","autoRollDamage","gmAutoDamage","autoCheckHit","autoCheckSaves","autoApplyDamage","autoItemEffects","autoTarget"].map(k=>[k,cfg[k]])),actors:game.actors.filter(a=>tag(a).key).length,scenes:game.scenes.filter(s=>tag(s).key).length};
  console.info(ID,"Diagnostics",report);
  const bad=[];
  if(game.system.version!=="6.0.6")bad.push("Версия системы отличается от целевой.");
  if(!game.modules.get("midi-qol")?.active)bad.push("Без Midi-QOL автоматическое применение урона не включено.");
  const midi=game.modules.get("midi-qol")?.version;
  if(midi && /^14\.0\./.test(midi))bad.push("Нужна версия Midi-QOL для dnd5e 6: историческая 14.6.0; ветка 14.0.x не является целевой.");
  if(!game.modules.get("sequencer")?.active)bad.push("Для анимаций включите Sequencer.");
  await foundry.applications.api.DialogV2.wait({window:{title:"Парус · Диагностика"},content:`<div class="pod-parusom"><table><thead><tr><th>Компонент</th><th>Установлено</th><th>Целевая сборка</th></tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${escape(v)}</td>`).join("")}</tr>`).join("")}</tbody></table><p>${bad.map(escape).join("<br>")||"Версии основных компонентов соответствуют цели. Это проверка состава, а не пройденный игровой тест."}</p><p>Эффекты на целях используют Sequencer и SVG. Анимации самих токенов используют встроенное воспроизведение WebM и запускаются через Midi-QOL. Для просмотра и подгрузки клипов откройте «Анимации способностей» в панели мастера. JB2A для этих клипов не требуется.</p><p>Подготовленных актёров: ${report.actors}; сцен: ${report.scenes}. Сначала проведите тест попадания, промаха, спасброска и половинного урона.</p></div>`,buttons:[{action:"download",label:"Скачать отчёт",callback:()=>foundry.utils.saveDataToFile(JSON.stringify(report,null,2),"application/json","Pod_parusom_diagnostics.json")},{action:"close",label:"Закрыть",default:true}],rejectClose:false});
  return report;
}
async function panel() {
  if(!gm())return;
  const actions=[["animationsPanel","Анимации способностей"],["finalePanel","Финалы: волны и работа"],["fatePanel","Судьба Хельмута / мир"],["upgradeFinales","Обновить финалы в мире"],["importAdventure","Импортировать приключение"],["diagnostics","Проверить сборку"],["configureAutomation","Включить автоматизацию бросков и урона"],["restoreAutomation","Вернуть прежние настройки Midi"],["startCombat","Создать бой на текущей сцене"],["multiattack","Мультиатака выбранного актёра"],["legendary","Легендарное действие"],["legendaryResistance","Потратить легендарное сопротивление"],["feature","Способность / реакция / стойка"],["reinforcements","Добавить резерв"],["repairPiero","Собрать Пьеро"],["randomEncounter","Случайная встреча"],["smokeTest","Проверочный бой"],["openBook","Открыть книгу PDF"]];
  return foundry.applications.api.DialogV2.wait({window:{title:"Под парусом · Панель мастера"},content:`<div class="pod-parusom"><p>Импорт создаёт материалы в отдельных папках. Повторный запуск сохраняет хиты и правки. При первом импорте включаются броски атак, спасбросков и применение урона в Midi-QOL; прежние настройки доступны для восстановления.</p><div class="pod-buttons">${actions.map(([key,text])=>`<button type="button" data-pod-action="${key}">${text}</button>`).join("")}</div><p>Выберите токен действующего персонажа, затем цели клавишей T. Укрытие, слышимость и право на реакцию проверяет мастер. Орудия требуют отдельного оператора.</p></div>`,buttons:[{action:"close",label:"Закрыть",default:true}],rejectClose:false});
}
async function startCombat() {
  if(!gm()||!canvas.scene)return;
  let chosen=canvas.tokens.controlled;
  if(!chosen.length) chosen=canvas.tokens.placeables.filter(t=>!t.document.hidden && tag(t.document).participant==="enemy" && !tag(t.actor).object && canAct(t.actor));
  if(!chosen.length)return err("Выберите участников боя. NPC и орудия не добавляются автоматически.");
  let combat=game.combats.find(c=>c.scene?.id===canvas.scene.id && !c.started);
  if(!combat)combat=await Combat.create({scene:canvas.scene.id,active:true});
  const existing=new Set(combat.combatants.map(c=>c.tokenId));
  await combat.createEmbeddedDocuments("Combatant",chosen.filter(t=>!existing.has(t.id)).map(t=>({tokenId:t.id,actorId:t.actor.id,hidden:t.document.hidden})));
  await combat.rollNPC({messageOptions:{rollMode:"gmroll"}});
  notify("Участники и инициатива готовы. Добавьте героев и нажмите «Начать бой».");
}
const attackPlans={VL:[["Два выстрела и кулак",["Выстрел орудия","Выстрел орудия","Массивный кулак"]],["Три кулака",["Массивный кулак","Массивный кулак","Массивный кулак"]]],H:[["Три пистолета",["Аркан-пистолет","Аркан-пистолет","Аркан-пистолет"]],["Три сабли",["Офицерская сабля","Офицерская сабля","Офицерская сабля"]],["Два пистолета и сабля",["Аркан-пистолет","Аркан-пистолет","Офицерская сабля"]],["Пистолет и две сабли",["Аркан-пистолет","Офицерская сабля","Офицерская сабля"]]],F:[["Две алебарды",["Комиссарская алебарда","Комиссарская алебарда"]],["Мушкет",["Мушкет"]]],ARM:[["Две алебарды",["Короткий удар алебардой","Короткий удар алебардой"]]],MILS:[["Два выстрела",["Мушкет","Мушкет"]],["Нож",["Нож"]]],KURT:[["Два меча",["Короткий меч","Короткий меч"]],["Арбалет",["Лёгкий арбалет"]]],WOLF:[["Два луча",["Индукционный луч","Индукционный луч"]]],OTTO:[["Два клинка",["Клинок из трости","Клинок из трости"]],["Пистолет",["Карманный пистолет"]]],REGM:[["Два меча",["Военный меч","Военный меч"]]],REGR:[["Два мушкета",["Военный мушкет","Военный мушкет"]],["Два ножа",["Армейский нож","Армейский нож"]]]};
async function multiattack(actor) {
  actor ??= await actorChoice();if(!actor)return;
  if(!canAct(actor))return err("Персонаж сейчас не может действовать.");
  const plans=attackPlans[tag(actor).key];if(!plans)return err("У этого персонажа нет Мультиатаки.");
  const i=await choose("Вариант Мультиатаки",plans.map(([name],i)=>[String(i),name]));if(i==null)return;
  for(const [index,name] of plans[Number(i)][1].entries()){
    if(index && !await confirm("Следующая атака",`Далее: ${name}. Можно сменить выбранную цель перед подтверждением. Продолжить?`))break;
    const result=await useItem(actor.items.find(it=>it.name===name));
    if(!result||result.aborted)break;
  }
}
async function legendary() {
  const a=await actorChoice();if(!a)return;
  if(!canAct(a))return err("Босс недееспособен или повержен.");
  if(game.combat?.combatant?.actor?.id===a.id)return err("Легендарное действие используется в конце чужого хода.");
  const list=a.items.filter(i=>tag(i).group==="legend");const id=await choose(`Легендарные действия: ${a.system.resources.legact.value}/3`,list.map(i=>[i.id,i.name]));if(!id)return;
  const it=a.items.get(id),cost=tag(it).legendaryCost;if(a.system.resources.legact.value<cost)return err("Недостаточно легендарных действий.");
  await useItem(it);
  if(firstActivity(it).type==="utility")await say(`${escape(it.name)}: ${escape(tag(it).source)} Мастер выполняет перемещение или выбирает союзника; ресурсы легендарного действия расходует система.`);
}
async function legendaryResistance() {
  const a=await actorChoice();if(!a?.system.resources.legres.max)return err("У выбранного персонажа нет легендарных сопротивлений.");
  if(a.system.resources.legres.value<1)return err("Легендарные сопротивления исчерпаны.");
  await a.update({"system.resources.legres.spent":a.system.resources.legres.spent+1});
  await say(`${escape(a.name)} расходует легендарное сопротивление. В карточке текущего спасброска измените результат на успех ДО применения урона. Уже применённый урон эта кнопка не отменяет.`);
  void game.modules.get(ID).api.tokenAnimations?.playForActor(a,tag(a).key==="VL"?"01_11":"02_17");
}
async function feature() {
  const a=await actorChoice();if(!a)return;
  const itId=await choose("Способность или реакция",a.items.filter(i=>firstActivity(i)?.type==="utility" && tag(i).group!=="legend").map(i=>[i.id,i.name]));
  if(!itId)return;const it=a.items.get(itId);
  if(it.name==="Мультиатака")return multiattack(a);
  if(it.name==="Декрет задержания"){
    const t=targets()[0];if(!t)return err("Выберите цель метки.");await a.setFlag(ID,"mark",t.document.uuid);await useItem(it);return;
  }
  if(it.name==="Прицельная стойка"){
    if(!await confirm("Прицельная стойка","Мушкетёр ещё не перемещался в этот ход? После стойки его скорость 0 до конца хода."))return;
    await a.setFlag(ID,"aim",{turn:stamp(),used:false});await stopMovement(a);await useItem(it);return notify("Следующий выстрел из военного мушкета получит преимущество. Скорость 0 до конца хода.");
  }
  if(it.name==="Удерживать рубеж"){
    if(!await confirm("Удерживать рубеж","Пехотинец прошёл не более 10 фт. за этот ход?"))return;
    await a.setFlag(ID,"brace",true);await stopMovement(a);await useItem(it);return;
  }
  if(it.name==="Зарядить арканган")return arcLoad(a);
  const result=await useItem(it);
  if(result)await say(`${escape(it.name)}: ${escape(tag(it).source)} <strong>Условие и изменение атаки проверяет мастер.</strong>`);
}
async function stopMovement(a){
  await a.createEmbeddedDocuments("ActiveEffect",[{name:"Стойка: скорость 0",img:"icons/svg/anchor.svg",transfer:false,changes:[{key:"system.attributes.movement.walk",mode:5,value:"0",priority:30}],flags:{[ID]:{expiry:"sourceEndCurrent",sourceActorId:a.id}}}]);
}
async function initializePiero() {
  const a=findActor("PIE");if(!a||tag(a).pieroInitialized)return;
  await a.update({"system.attributes.hp.value":1,"system.attributes.movement.walk":0,[`flags.${ID}.pieroInitialized`]:true,[`flags.${ID}.broken`]:true});
}
async function repairPiero() {
  const a=findActor("PIE");if(!a)return err("Сначала импортируйте актёров.");
  if(!tag(a).broken)return notify("Пьеро уже собран. Повторный ремонт хиты не восстанавливает.");
  if(!await confirm("Ремонт Пьеро","Прошло 10 минут и проверка с инструментами Сл 12 успешна?"))return;
  await a.update({"system.attributes.hp.value":6,"system.attributes.movement.walk":25,[`flags.${ID}.broken`]:false});notify("Пьеро собран: 6 хитов, скорость 25 фт. Общий актёр обновлён во всех сценах.");
  for(const scene of game.scenes){const show=scene.tokens?.filter(t=>tag(t).requiresRepaired).map(t=>({_id:t.id,hidden:false}));if(show?.length)await scene.updateEmbeddedDocuments("Token",show);}
}
async function reinforcements() {
  if(!gm()||!canvas.scene)return;
  const data=await content(), source=tag(canvas.scene).sourceScene,e=data.encounters.find(e=>e.id===source);
  if(!e || e.variants.length<2)return err("Для этой сцены нет отдельного варианта подкреплений.");
  const id=await choose("Выбрать усиление",e.variants.slice(1).map((v,i)=>[String(i+1),v.label+" · "+v.extra]));if(id==null)return;
  const base=new Map(e.variants[0].units),want=e.variants[Number(id)].units,already=new Map();
  for(const t of canvas.scene.tokens){const k=tag(t).key;already.set(k,(already.get(k)??0)+1);}
  const tokenData=[];let i=0;
  for(const [key,q] of want){for(let j=0;j<Math.max(0,q-Math.max(base.get(key)??0,already.get(key)??0));j++){
    const a=findActor(key);if(!a)continue;const t=await a.getTokenDocument({x:canvas.grid.size*(1+i%4),y:canvas.grid.size*(1+Math.floor(i/4)),hidden:true});const d=t.toObject();delete d._id;d.flags??={};d.flags[ID]={key,encounter:tag(canvas.scene).key,participant:"enemy",reserve:true};tokenData.push(d);i++;
  }}
  if(tokenData.length)await canvas.scene.createEmbeddedDocuments("Token",tokenData);
  notify("Резерв добавлен скрытым в левом верхнем углу. Разместите его у подходящего входа и покажите в назначенный раунд.");
}
async function randomEncounter() {
  const roll=await new Roll("1d8").evaluate();await roll.toMessage({flavor:"Случайная встреча Фортмайнвагена",rollMode:"gmroll"});
  const sc=game.scenes.find(s=>tag(s).key==="R"+roll.total);if(sc)await sc.view();else err("Сначала импортируйте сцены.");
  await say("Перед использованием встречи проверьте, что именные NPC доступны, Пьеро собран, а банда ещё не разогнана. Невозможный результат перебрасывается.");
}
async function arcLoad(a) {
  if(!await confirm("Зарядить арканган","Оператор у пульта тратит действие. Он в пределах 5 фт. и ещё не действовал?"))return;
  if(a.system.attributes.hp.value<=0)return err("Орудие разрушено.");
  await a.setFlag(ID,"loaded",true);notify("Арканган заряжен.");
  void game.modules.get(ID).api.tokenAnimations?.playForActor(a,"20_01");
}
async function damageBonus({workflow,actor,item}) {
  const key=tag(actor).key,hit=[...(workflow.hitTargets??[])][0];
  if(!["REGM","F"].includes(key)||!hit||!game.combat||game.combat.combatant?.tokenId!==workflow.tokenId)return {};
  if(tag(actor).bonusTurn===stamp())return {};
  if(key==="REGM" && item?.name!=="Военный меч")return {};
  if(key==="REGM" && !canvas.tokens.placeables.some(t=>t.id!==workflow.tokenId && canAct(t.actor) && ["REGM","REGR","MIL","MILS","H"].includes(tag(t.actor).key) && distance(t,hit)<=5.1))return {};
  if(key==="F" && tag(actor).mark!==hit.document.uuid)return {};
  await actor.setFlag(ID,"bonusTurn",stamp());
  workflow.podParusomAnimationVariant=key==="REGM"?"18_06":"03_07";
  const type=[...firstActivity(item).damage.parts[0].types][0];return {damageRoll:`1d6[${type}]`,flavor:key==="REGM"?"Строевой натиск · один раз в свой ход":"Приоритетная цель · один раз в свой ход"};
}
const animated=new Set();
async function animate(w) {
  if(!primary()||!game.modules.get("sequencer")?.active||!globalThis.Sequence)return;
  const kind=tag(w.item).animation,file=targetEffectFile(kind);if(!file)return;
  const wfId=w.uuid??w.id;if(animated.has(wfId))return;animated.add(wfId);if(animated.size>500)animated.delete(animated.values().next().value);
  const source=w.token??canvas.tokens.get(w.tokenId);if(!source)return;
  const destinations=[...(w.targets??[])];
  try{
    for(const target of destinations){
      const seq=new Sequence();let effect=seq.effect().file(BASE+"assets/fx/"+file);
      effect.atLocation(target).scaleToObject(kind==="burst"?1.4:1).duration(650).fadeIn(80).fadeOut(250);
      await seq.play();
    }
  }catch(e){console.warn(ID,"Animation",e);}
}
async function completed(w) {
  if(!primary()||!tag(w.item).key||w.aborted)return;
  await animate(w);
  const f=tag(w.item),actor=w.actor;
  if(f.special==="arcFire"){
    await actor.setFlag(ID,"loaded",false);await actor.setFlag(ID,"lastShot",game.combat?`${game.combat.id}:${game.combat.round}`:null);
  }
  if(f.followup==="prone" && w.hitTargets?.size){
    await say("После легендарного кулака: выберите попавшие цели Большого или меньшего размера и проведите спасбросок Силы Сл 16. При провале — ничком. Дополнительный урон не наносится.");
  }
  if(w.item.name.startsWith("Подавляющий залп"))await say("После залпа Влади-Лен может сделать один удар кулаком. Выберите цель и используйте отдельную атаку, без повторной Мультиатаки.");
}
async function preUse(w) {
  if(!tag(w.item).key)return true;
  delete w.podParusomAnimationVariant;
  const a=w.actor,f=tag(w.item);
  if(tag(a).broken && w.item.name!=="Сигнал тревоги")return err("Разобранный Пьеро не может атаковать или защищать реакцией."),false;
  if(f.restrict){
    for(const t of w.targets??[]){if(t.actor.id===a.id||t.actor.system.details.type.value!==f.restrict)return err("Способность требует других союзников указанного типа."),false;}
  }
  if(w.item.name.startsWith("Полевой ремонт") && [...w.targets??[]].some(t=>!tag(t.actor).object&&t.actor.system.details.type.value!=="construct"))return err("Полевой ремонт действует на конструктов и предметы."),false;
  if(w.item.name.startsWith("Лечение ран") && [...w.targets??[]].some(t=>["construct","undead"].includes(t.actor.system.details.type.value)))return err("Лечение ран не действует на конструктов и нежить."),false;
  if(f.special==="arcFire"){
    if(!tag(a).loaded||a.system.attributes.hp.value<=0)return err("Арканган не заряжен или разрушен."),false;
    if(game.combat && tag(a).lastShot===`${game.combat.id}:${game.combat.round}`)return err("Арканган уже стрелял в этом раунде."),false;
    if(!await confirm("Выстрел аркангана","Оператор у пульта тратит своё действие на наведение и выстрел. Это не дополнительная атака оператора. Условия выполнены?"))return false;
  }
  return true;
}
async function beforeAttack(w) {
  const a=w.actor;if(!tag(a).key)return;
  const aim=tag(a).aim;
  if(aim && !aim.used && aim.turn===stamp() && stamp() && w.item.name==="Военный мушкет"){
    w.advantage=true;await a.setFlag(ID,"aim",{...aim,used:true});
  }
}
const previousTurns=new Map();
async function turnUpdate(combat,changed) {
  if(!primary()||!("turn" in changed||"round" in changed))return;
  const a=combat.combatant?.actor;if(!a)return;
  if(tag(a).key && a.system.resources.legact.max)await a.update({"system.resources.legact.spent":0});
  if(tag(a).mark)await a.unsetFlag(ID,"mark");
  if(tag(a).brace)await a.unsetFlag(ID,"brace");
  const previous=previousTurns.get(combat.id);previousTurns.delete(combat.id);
  // Count source turn endings: an effect used on its own turn expires after its next turn ends.
  for(const actor of [...game.actors,...canvas.tokens.placeables.filter(t=>!t.document.actorLink).map(t=>t.actor)]){
    for(const effect of actor.effects.filter(e=>tag(e).expiry==="sourceEndCurrent" && tag(e).sourceActorId===previous?.actorId))await effect.delete();
    for(const effect of actor.effects.filter(e=>tag(e).expiry==="sourceEndNext" && tag(e).sourceActorId===previous?.actorId)){
      const left=(tag(effect).sourceEndsRemaining??2)-1;
      if(left<=0)await effect.delete();else await effect.setFlag(ID,"sourceEndsRemaining",left);
    }
  }
}
async function smokeTest() {
  if(!gm())return;
  const actors=[findActor("PAT"),findActor("CIV"),findActor("KURT")];if(actors.some(a=>!a))return err("Сначала импортируйте приключение.");
  const scene=await Scene.create({name:"Парус · ПРОВЕРОЧНЫЙ БОЙ",width:1600,height:1000,padding:0,grid:{type:1,size:100,distance:5,units:"ft"},tokenVision:false,environment:{globalLight:{enabled:true}},flags:{[ID]:{key:"test-"+foundry.utils.randomID()}}});
  const docs=[];for(const [i,a] of actors.entries()){const t=await a.getTokenDocument({x:200+i*300,y:400,actorLink:false,name:"ТЕСТ · "+a.name});const d=t.toObject();delete d._id;docs.push(d);}
  await scene.createEmbeddedDocuments("Token",docs);await scene.view();
  await say("Проверка на независимых копиях: 1) патруль атакует гражданского — попадание снимает хиты, промах нет; 2) бутылка Курта: шаблон, Ловкость Сл 12, 2к6 огня, успех половина; 3) проверьте яд против иммунитета конструкта; 4) повторите из игрокового клиента. Проверочная сцена не изменяет сюжетных NPC. Итог зафиксируйте в диагностике.");
}
function openBook(){window.open(BASE+"books/Pod_parusom_campaign_book.pdf","_blank");}
const api={panel,importAdventure,diagnostics,configureAutomation,restoreAutomation,startCombat,multiattack,legendary,legendaryResistance,feature,repairPiero,reinforcements,randomEncounter,smokeTest,openBook,damageBonus};
Hooks.once("init",()=>{
  for(const [key,type,value] of [["importedVersion",String,""],["midiBackup",Object,{}],["rechargeBackup",String,""]])game.settings.register(ID,key,{scope:"world",config:false,type,default:value});
});
Hooks.once("ready",async()=>{
  game.modules.get(ID).api=api;globalThis.PodParusom=api;
  document.addEventListener("click",event=>{const button=event.target.closest?.("[data-pod-action]");if(!button||!gm())return;const action=button.dataset.podAction;if(api[action]){event.preventDefault();Promise.resolve(api[action]()).catch(e=>{console.error(ID,e);err(e.message);});}});
  if(primary())await say('<strong>Под парусом на костылях</strong><br><button type="button" data-pod-action="panel">Открыть панель мастера</button>');
});
Hooks.on("midi-qol.preItemRoll",preUse);
Hooks.on("midi-qol.preAttackRoll",beforeAttack);
Hooks.on("midi-qol.RollComplete",completed);
Hooks.on("updateCombat",turnUpdate);
Hooks.on("preUpdateCombat",(combat,changed)=>{
  if("turn" in changed||"round" in changed)previousTurns.set(combat.id,{actorId:combat.combatant?.actor?.id});
});
Hooks.on("createActiveEffect",async(effect)=>{
  if(!primary()||tag(effect).expiry!=="sourceEndNext"||!game.combat)return;
  const key=tag(effect).sourceKey,source=findActor(key);if(!source)return;
  await effect.update({[`flags.${ID}.sourceActorId`]:source.id,[`flags.${ID}.sourceEndsRemaining`]:game.combat.combatant?.actor?.id===source.id?2:1});
});
