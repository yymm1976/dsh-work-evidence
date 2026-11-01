import path from 'node:path';
import {VERSION} from "./runtime.mjs";

export function registerPluginCommand({ctx,runtime,state,effects,available,capabilityDiagnostic,contextEconomics,taskFlow,taskHandoff,finalJson,qualityReview,executionEvidence,workingSet,compressionControl,compactionHandoff,contextWindow,observationLedger,historyCoordinator,clearPluginState,applyToolSurface}){
  ctx.commands.register({name:'work-evidence',
    description:'Inspect plugin status, export task handoff JSON and control the session switch. Mode follows the selected reasoning effort.',
    input:{hint:'status | detail | handoff | on | off | inherit | mode | aggressive on|off'},
    handler:async({agent,rawInput,signal})=>{
      if(!agent)return {kind:'error',text:'No active session is available.'};
      try{
        await runtime.init(agent,signal);
        const action=String(rawInput||'').trim().toLowerCase()||'status';
        if(action==='handoff')return {kind:'success',text:JSON.stringify(taskHandoff(agent))};
        const contextWindowMetrics=contextWindow.metrics(agent);
        const before=runtime.isEnabled(agent);
        let sessionChange=null;
        if(action==='on')sessionChange=await runtime.setSessionEnabled(agent,true,signal);
        else if(action==='off')sessionChange=await runtime.setSessionEnabled(agent,false,signal);
        else if(action==='inherit')sessionChange=await runtime.setSessionEnabled(agent,null,signal);
        else if(action==='aggressive on'||action==='aggressive off'){
          sessionChange=await runtime.setAggressiveMode(agent,action==='aggressive on',signal);
          if(before!==runtime.isEnabled(agent)){runtime.clearSessionState(agent);clearPluginState(agent);}
          applyToolSurface(agent);
          return {kind:'success',text:JSON.stringify({version:VERSION,mode:sessionChange,aggressiveMode:state(agent).config.aggressiveMode})};
        }
        else if(action==='mode'){}
        else if(/^mode\s+\S+$/u.test(action)){const mode=action.split(/\s+/u)[1];sessionChange=await runtime.setSessionMode(agent,mode==='inherit'?null:mode,signal);}
        else if(/^workspace-mode\s+\S+$/u.test(action))sessionChange=await runtime.setWorkspaceMode(agent,action.split(/\s+/u)[1],signal);
        else if(!['status','detail'].includes(action))return {kind:'error',text:'Usage: /work-evidence status | detail | handoff | on | off | inherit | mode | aggressive on|off'};
        if(before!==runtime.isEnabled(agent))clearPluginState(agent);
        if(action==='mode'||action.startsWith('mode ')||action.startsWith('workspace-mode '))return {kind:'success',text:JSON.stringify({
          loaded:true,version:VERSION,sessionId:agent.session.id,effective:runtime.isEnabled(agent),mode:runtime.modeStatus(agent),
          policyPath:action.startsWith('workspace-mode ')?path.join(state(agent).dir,'config.json'):state(agent).sessionPolicyPath,
          ...(action!=='mode'?{settingsSaved:true}:{}),
          note:'模式由思考档位决定：Ultra 使用质量模式，其他档位在 aggressiveMode 开启时使用激进模式，关闭时交给宿主；切换从下一次模型请求生效。'} )};
        const s=state(agent),snapshot=runtime.snapshot(s);
        const value={...snapshot,mode:runtime.modeStatus(agent),loaded:true,version:VERSION,sessionId:s.id,
          effective:runtime.isEnabled(agent),workspaceDefaultEnabled:s.config.enabled,sessionEnabledOverride:s.sessionEnabledOverride,
          policyPath:s.sessionPolicyPath,sessionChange,features:snapshot.features,sw:contextWindowMetrics,ledger:observationLedger.metrics(agent),metrics:s.metrics,problems:s.problems,
          diagnostic:capabilityDiagnostic(agent),
          executionTools:executionEvidence.available(agent),workProbeAvailable:!!ctx.tools.get('work_probe',agent),
          note:'This command proves the module loaded and reports the effective session gate. It does not claim task correctness.'};
        if(action==='detail')value.detail={
          state:runtime.stateSnapshot(s,true),
          ledger:observationLedger.detail(agent),
          observability:effects.snapshot(agent),
          coordination:historyCoordinator.summary(agent),
          workingSet:workingSet.detail(agent),
          contextEconomics:contextEconomics.summary(agent),
          compression:{...compressionControl.metrics(agent),nativeHandoff:compactionHandoff.metrics(agent)},
          taskFlow:taskFlow.summary(agent),
          finalJson:finalJson.summary(agent),qualityReview:qualityReview.summary(agent),
          nativeExecution:executionEvidence.summary(agent),
          sw:{...contextWindowMetrics,...contextWindow.detail(agent)},
        };
        return {kind:'success',text:JSON.stringify(value)};
      }catch(error){
        return {kind:'error',text:'work-evidence command failed: '+error.message};
      }
    }});
}
