const STEP_MODULES=Object.freeze(['gates','dungeons','event','boss_hunt','battle_pass','adventure_quests']);
function normalizeCustomRuns(input={},areas=[],profiles={},combatProfiles={}) {
 const runs={};const source=input?.runs&&typeof input.runs==='object'&&!Array.isArray(input.runs)?input.runs:{};
 for(const [id,raw] of Object.entries(source).slice(0,50)) {
  if(!/^run_[a-z0-9-]{1,64}$/.test(id)||!raw||typeof raw!=='object')continue;
  const steps=(Array.isArray(raw.steps)?raw.steps:[]).slice(0,50).flatMap((s,i)=>{
   if(!s||!STEP_MODULES.includes(s.module))return [];
   const kind={gates:'gate',dungeons:'dungeon',event:'event'}[s.module];
   const area=areas.find(a=>a.key===s.areaKey&&a.hidden!==true&&a.type===kind);
   if(kind&&!area)return [];
   return [{id:String(s.id||'step_'+i).slice(0,80),module:s.module,areaKey:kind?area.key:null,profileId:Object.hasOwn(profiles,s.profileId)?s.profileId:'default',combatProfileId:Object.hasOwn(combatProfiles,s.combatProfileId)?s.combatProfileId:'default',enabled:s.enabled!==false}];
  });
  const seconds=(v,d,min)=>Math.min(3600,Math.max(min,Number(v)||d));
  runs[id]={id,name:String(raw.name||'New run').trim().slice(0,80)||'New run',mode:raw.mode==='priority'?'priority':'sequential',idleSeconds:seconds(raw.idleSeconds,45,5),roundSeconds:seconds(raw.roundSeconds,60,10),steps};
 }
 return {activeId:Object.hasOwn(runs,input?.activeId)?input.activeId:Object.keys(runs)[0]||null,runs};
}
class CustomRunCoordinator {
 constructor(run,now=()=>Date.now()){this.run=run;this.now=now;this.steps=run.steps.filter(s=>s.enabled);this.index=0;this.frontier=0;this.probing=false;this.visited=new Set();this.idleSince=null;this.backoffUntil=0;this.reason='Starting run';}
 get step(){return this.steps[this.index]||null;}
 observe(kind,protectedState=false){
  if(!this.step||protectedState||kind==='blocked'){this.idleSince=null;return null;}
  if(kind==='work'){this.idleSince=null;this.visited.clear();this.frontier=this.index;this.probing=false;this.reason='Working';return null;}
  if(kind!=='idle')return null;
  const now=this.now();if(now<this.backoffUntil)return null;
  if(this.idleSince===null){this.idleSince=now;this.reason='Step idle; waiting before advancing';}
  if(now-this.idleSince<this.run.idleSeconds*1000)return null;
  this.visited.add(this.index);this.idleSince=null;
  if(this.visited.size===this.steps.length){this.index=0;this.frontier=0;this.probing=false;this.visited.clear();this.backoffUntil=now+this.run.roundSeconds*1000;this.reason='Full pass idle; waiting before rechecking';return this.step;}
  if(this.run.mode==='priority'){
   if(this.probing&&this.index<this.frontier-1)this.index++;
   else if(this.probing){this.index=this.frontier;this.probing=false;}
   else{this.frontier=(this.index+1)%this.steps.length;this.index=this.index===0?this.frontier:0;this.probing=this.index===0&&this.frontier>0;}
  }else this.index=(this.index+1)%this.steps.length;
  this.reason='Previous step has no usable work';return this.step;
 }
 status(){const now=this.now();return {name:this.run.name,step:this.index+1,total:this.steps.length,module:this.step?.module,reason:this.reason,remainingSeconds:Math.max(0,Math.ceil(((this.backoffUntil>now?this.backoffUntil:this.idleSince===null?now:this.idleSince+this.run.idleSeconds*1000)-now)/1000)),backoff:this.backoffUntil>now};}
}
function projectStep(config,step){const next=JSON.parse(JSON.stringify(config));next.general.module=step.module;
 if(step.module==='gates')next.general.primaryGateMap=step.areaKey;
 if(step.module==='dungeons')next.general.dungeonMap=step.areaKey;
 if(step.module==='event')next.general.eventMap=step.areaKey;
 next.general.map=step.areaKey;next.progressionProfiles.activeId=step.profileId;next.combatProfiles.activeId=step.combatProfileId;return next;}
module.exports={STEP_MODULES,normalizeCustomRuns,CustomRunCoordinator,projectStep};
