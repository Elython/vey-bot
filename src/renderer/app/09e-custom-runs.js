const runModules=[['adventure_quests',uiText('Adv Quests')],['boss_hunt',uiText('Boss Hunt')],['dungeons',uiText('Dungeons')],['gates',uiText('Gates')],['event',uiText('Event')],['battle_pass',uiText('Battle Pass')]];
let customRunConfig={
  activeId:null,runs:{
  }
};
let customRunProfiles={
  default:{
    name:'Default'
  }
};
let customRunCombatProfiles={
  default:{
    name:'Default'
  }
};
function nextCustomRunName(){
  const names=new Set(Object.values(customRunConfig.runs).map(run=>run.name.toLowerCase()));
  let number=1;
  while(names.has('run '+number))number++;
  return 'Run '+number;
}
const runEl=id=>document.getElementById(id);
function runOptions(select,options,value){
  select.replaceChildren();
  for(const [key,label] of options){
    const o=document.createElement('option');
    o.value=key;
    o.textContent=label;
    select.append(o);
  }
  select.value=value||'';
}
function loadCustomRuns(config){
  customRunConfig=structuredClone(config.customRuns||{
    activeId:null,runs:{
    }
  });
  customRunProfiles=config.progressionProfiles?.profiles||{
    default:{
      name:'Default'
    }
  };
  customRunCombatProfiles=config.combatProfiles?.profiles||{
    default:{
      name:'Default'
    }
  };
  renderCustomRuns();
}
async function persistCustomRuns(){
  const result=await updateCanonicalConfig({
    customRuns:structuredClone(customRunConfig)
  });
  if(!result?.success)appendLog('ERROR',result?.error||'Could not save Custom Runs');
}
function renderCustomRuns(){
  const options=Object.entries(customRunConfig.runs).map(([id,r])=>[id,r.name]);
  runOptions(runEl('selectCustomRun'),options,customRunConfig.activeId);
  runOptions(runEl('selectSetupCustomRun'),options,customRunConfig.activeId);
  const run=customRunConfig.runs[customRunConfig.activeId];
  for(const id of ['inputRunName','selectRunMode','inputRunIdle','inputRunRound','btnAddRunStep','btnDuplicateRun','btnDeleteRun','btnRenameRun'])runEl(id).disabled=!run;
  runEl('inputRunName').value=run?.name||'';
  runEl('selectRunMode').value=run?.mode||'sequential';
  runEl('inputRunIdle').value=run?.idleSeconds||45;
  runEl('inputRunRound').value=run?.roundSeconds||60;
  runEl('customRunOrderHint').textContent=run?.mode==='priority'    ? uiText('Before moving farther down the list, recheck earlier steps in case new work has appeared.')    : uiText('Step 1 → Step 2 → Step 3 → back to Step 1. Disabled steps are skipped.');
  const tbody=runEl('customRunSteps');
  tbody.replaceChildren();
  if(!run || !run.steps.length){
    const empty=document.createElement('p');
    empty.className='custom-run-empty';
    empty.textContent=run?uiText('No steps yet. Press Add step to choose the first activity.'):uiText('Create a New run to get started.');
    tbody.append(empty);
  }
  for(const [index,step] of (run?.steps||[]).entries()){
    const tr=document.createElement('article');
    tr.className='custom-run-step';
    tr.classList.toggle('custom-run-step-disabled',step.enabled===false);
    const heading=document.createElement('div');
    heading.className='custom-run-step-heading';
    const title=document.createElement('span');
    title.className='custom-run-step-title';
    title.textContent=uiText('Step ')+(index+1);
    heading.append(title);
    tr.append(heading);
    const fields=document.createElement('div');
    fields.className='custom-run-step-fields';
    tr.append(fields);
    const cell=(node,label)=>{
      const field=document.createElement('label');
      field.className='custom-run-field';
      const text=document.createElement('span');
      text.textContent=label;
      field.append(text,node);
      fields.append(field);
    };
    const select=(options,value,change)=>{
      const s=document.createElement('select');
      s.className='tree-select';
      runOptions(s,options,value);
      s.addEventListener('change',()=>{
        change(s.value);
        persistCustomRuns();
        renderCustomRuns();
      });
      return s;
    };
    cell(select(runModules,step.module,value=>{
      step.module=value;
      const type={
        gates:'gate',dungeons:'dungeon',event:'event'
      }
      [value];
      step.areaKey=monsterCatalog.find(a=>a.type===type&&!a.hidden)?.key||null;
    }),uiText('Activity'));
    const type={
      gates:'gate',dungeons:'dungeon',event:'event'
    }
    [step.module];
    const areas=type?monsterCatalog.filter(a=>a.type===type&&!a.hidden).map(a=>[a.key,a.label]):[['','—']];
    const area=select(areas,step.areaKey,v=>step.areaKey=v||null);
    area.disabled=!type;
    area.title=type?uiText('Choose where this step runs'):uiText('This activity uses its own configured targets, not one area');
    cell(area,uiText('Where to run'));
    cell(select(Object.entries(customRunProfiles).map(([id,p])=>[id,id==='default'?uiText('Default'):p.name]),step.profileId,v=>step.profileId=v),uiText('Progression config'));
    cell(select(Object.entries(customRunCombatProfiles).map(([id,p])=>[id,id==='default'?uiText('Default'):p.name]),step.combatProfileId,v=>step.combatProfileId=v),uiText('Combat config'));
    const enabled=document.createElement('input');
    enabled.type='checkbox';
    enabled.className='tree-checkbox';
    enabled.checked=step.enabled!==false;
    enabled.addEventListener('change',()=>{
      step.enabled=enabled.checked;
      tr.classList.toggle('custom-run-step-disabled',!enabled.checked);
      persistCustomRuns();
    });
    const enabledLabel=document.createElement('label');
    enabledLabel.className='custom-run-step-enabled';
    enabledLabel.append(enabled,document.createTextNode(uiText('Use this step')));
    heading.append(enabledLabel);
    const actions=document.createElement('span');
    actions.className='custom-run-step-actions';
    for(const [label,offset] of [[uiText('Up'),-1],[uiText('Down'),1],[uiText('Remove'),0]]){
      const b=document.createElement('button');
      b.className='btn btn-sm';
      b.append(createLucideIcon(offset===-1?'arrow-up':offset===1?'arrow-down':'trash-2'));
      b.title=offset===-1?uiText('Move step earlier'):offset===1?uiText('Move step later'):uiText('Remove this step');
      b.setAttribute('aria-label',b.title);
      if(!offset)b.append(document.createTextNode(uiText('Remove')));
      b.disabled=offset!==0&&(index+offset<0||index+offset>=run.steps.length);
      b.addEventListener('click',()=>{
        if(!offset)run.steps.splice(index,1);
        else [run.steps[index],run.steps[index+offset]]=[run.steps[index+offset],run.steps[index]];
        persistCustomRuns();
        renderCustomRuns();
      });
      actions.append(b);
    }
    heading.append(actions);
    tbody.append(tr);
  }
  refreshLucideIcons(tbody);
}
for(const id of ['selectCustomRun','selectSetupCustomRun'])runEl(id).addEventListener('change',()=>{
  customRunConfig.activeId=runEl(id).value;
  persistCustomRuns();
  renderCustomRuns();
});
runEl('btnCreateRun').addEventListener('click',()=>{
  if(Object.keys(customRunConfig.runs).length>=50)return;
  const id='run_'+crypto.randomUUID();
  customRunConfig.runs[id]={
    id,name:nextCustomRunName(),mode:'sequential',idleSeconds:45,roundSeconds:60,steps:[]
  };
  customRunConfig.activeId=id;
  persistCustomRuns();
  renderCustomRuns();
});
runEl('btnDuplicateRun').addEventListener('click',()=>{
  if(Object.keys(customRunConfig.runs).length>=50)return;
  const r=customRunConfig.runs[customRunConfig.activeId];
  if(!r)return;
  const id='run_'+crypto.randomUUID();
  customRunConfig.runs[id]={
    ...structuredClone(r),id,name:r.name+' copy'
  };
  customRunConfig.activeId=id;
  persistCustomRuns();
  renderCustomRuns();
});
runEl('btnDeleteRun').addEventListener('click',()=>{
  if(!confirm(uiText('Delete this Custom Run?')))return;
  const deleted=customRunConfig.activeId;
  delete customRunConfig.runs[deleted];
  customRunConfig.activeId=Object.keys(customRunConfig.runs)[0]||null;
  updateCanonicalConfig({
    customRuns:{
      ...structuredClone(customRunConfig),runs:{
        ...structuredClone(customRunConfig.runs),[deleted]:null
      }
    }
  });
  renderCustomRuns();
});
runEl('btnAddRunStep').addEventListener('click',()=>{
  const r=customRunConfig.runs[customRunConfig.activeId];
  if(!r||r.steps.length>=50)return;
  r.steps.push({
    id:'step_'+crypto.randomUUID(),module:'adventure_quests',areaKey:null,profileId:'default',combatProfileId:'default',enabled:true
  });
  persistCustomRuns();
  renderCustomRuns();
});
for(const [id,key] of [['inputRunName','name'],['selectRunMode','mode'],['inputRunIdle','idleSeconds'],['inputRunRound','roundSeconds']])runEl(id).addEventListener('change',()=>{
  const r=customRunConfig.runs[customRunConfig.activeId];
  if(!r)return;
  r[key]=runEl(id).type==='number'?Number(runEl(id).value):runEl(id).value;
  persistCustomRuns();
  renderCustomRuns();
});
runEl('btnCustomRunsPageInfo').addEventListener('click',()=>showInfoDialog({
  title:uiText('Custom Runs guide'),  body:uiText('A Custom Run is a saved list of activities for the bot. You can create several runs and choose one in Bot Setup. New run starts empty; Duplicate copies an existing run. Deleting a run does not delete the targets or Progression configs it uses.\n\n1. Give your run a name, then Add step. Choose an Activity, its Gate/Dungeon/Event if needed, a Progression config, and a Combat config. Configure its monsters in the activity’s own tab. Use this step allows you to temporarily skip a step without removing it. The arrow buttons change the order.\n\n2. Run in order moves through the list and returns to the beginning. Prioritize earlier steps checks earlier activities again before moving farther down the list, so new higher-priority work can be picked up.\n\n3. Wait before leaving an idle step is the time the current activity must have no usable work. Productive work resets this timer. Permitted loot, Chapters and potion fallbacks are considered first. Errors, challenges, pending requests, active PvP and locked loot batches do not count as completion. Hard safety limits still stop the bot.\n\n4. Wait when the whole run is idle prevents repeated rapid scans when none of its steps has work.\n\n5. Select Custom Run and the saved run in Bot Setup. Press the header Save to apply edits, then Start. Overview shows the current step and wait reason. Stop and a new Start begin at step 1.\n\nServer Auto Farm is not a run step yet because it keeps running independently on the game server.')
}));
runEl('btnRenameRun').addEventListener('click',()=>runEl('inputRunName').dispatchEvent(new Event('change',{
  bubbles:true
})));
