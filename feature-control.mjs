import fs from 'node:fs/promises';
import path from 'node:path';
import {defaults,RETIRED_SETTINGS,VERSION} from './runtime.mjs';
import {archiveDecoderStatus} from './archive-store.mjs';
import {featureSetting} from './effect-observer.mjs';

const DEFINITIONS=[
  ['enabled','总开关','允许当前工作区使用插件'],
  ['aggressiveMode','激进模式','非 Ultra 档位的任务处理'],
  ['selfIndex','源码索引','记录并核对已观察的源码入口'],
  ['fastEditEnabled','Java 编辑','按语法实体读取和修改 Java'],
  ['stateLedger','状态记录','记录读取、修改和执行依据'],
  ['stateInform','状态提醒','提醒已记录结果的适用状态'],
  ['completionNotice','完成提醒','继续尚有明确可执行事项的阶段摘要'],
  ['archiveReadRouting','归档读取','将归档路径转入准确来源读取'],
  ['readArgumentRecovery','读取参数纠错','修正明确的读取参数别名'],
  ['requestAccounting','用量记录','区分主请求、压缩和辅助调用'],
  ['evidenceViews','来源视图','按实际可见正文提供来源引用'],
  ['memberParsing','源码成员','定位准确的类和方法范围'],
  ['mavenSourceBinding','Maven 来源','核对依赖坐标与源码归属'],
  ['contextProtocol','上下文处理','处理可恢复的旧工具正文'],
  ['historyHygiene','历史清理','减少仍有准确来源的重复历史'],
  ['ledgerReceipt','来源回执','已有正文可见时返回短回执'],
  ['ledgerUnresolved','未解决事项','保留尚未解除的实际问题'],
  ['swLedger','重复结果记录','记录可供 SW 折叠的完整结果'],
  ['swEviction','重复结果折叠','将旧重复正文指向仍可见的原文'],
  ['requestProjection','请求投影','按需要减少当前请求中的旧观察'],
  ['projectionRestore','投影恢复','恢复请求再次需要的原始正文'],
  ['compressionControl','压缩衔接','协调原生压缩与准确来源恢复'],
  ['deferPressureCompaction','压力压缩延后','按有效请求预算决定是否延后'],
  ['stubSummary','简短交接','条件满足时使用可恢复的交接摘要'],
  ['executionTriage','执行恢复','提供实际失败位置和程序版本'],
  ['nativeProgramReuse','PTC 程序引用','显式复用同一会话的原程序文字'],
  ['structuredCalls','结构化调用','用现有工具参数直接提交独立动作'],
  ['nativeReasoningReplay','原生推理传递','向兼容通道传递准确的已有推理'],
  ['stageWorkingSet','阶段状态','保留当前阶段及必要来源'],
  ['stepPacing','过程指引','按当前缺口提供有界执行指引'],
  ['retainedCompute','保留计算','在后续步骤复用只读 Node 状态'],
  ['finalJsonGuard','JSON 格式','修正用户明确要求的 JSON 格式'],
  ['finalJsonResultGuard','JSON 结果一致性','核对结果字段与明确观察'],
  ['qualityReview','交付复核','复核有直接依据的交付遗漏'],
  ['qualityReviewEffort','复核思考档位','独立选择复核档位，主任务档位保留',['auto','inherit','low','medium','high','max']],
  ['qualityReviewScope','复核源码范围','auto 在较大输入中聚焦源码文件，full 保留全部已装配片段',['auto','full']],
  ['toolSurface','工具入口','compact 保留常用入口，full 展示管理和工程工具',['compact','full']],
  ['defaultResponseView','默认来源返回','选择完整正文或已有正文的短引用',['full','reference-if-visible']],
];
const TOOLS=['project_evidence','work_exec','work_recall','work_status','work_state','work_report','work_probe','evidence_index','candidate_select','ptc_patterns','ptc_fastpath','verified_exec','fastedit_java','work_compute'];
const PACKAGE_DEFAULTS=defaults();
const REQUIRES={stateInform:['stateLedger'],swEviction:['swLedger'],requestProjection:['projectionRestore'],projectionRestore:['requestProjection'],
  deferPressureCompaction:['compressionControl'],stubSummary:['compressionControl'],nativeProgramReuse:['executionTriage'],finalJsonResultGuard:['finalJsonGuard']};
export const featureDefinition=name=>DEFINITIONS.find(([key])=>key.toLowerCase()===String(name).toLowerCase());
export function featurePatch(name,value){
  const definition=featureDefinition(name);
  if(!definition){
    const retired=RETIRED_SETTINGS.find(key=>key.toLowerCase()===String(name).toLowerCase());
    throw new Error(retired?'Setting '+retired+' is retired and has no active implementation.':'Unknown feature: '+name);
  }
  const [key,,,choices]=definition;
  if(choices){if(!choices.includes(value))throw new Error(key+' accepts '+choices.join(' | '));return {[key]:value};}
  if(!['on','off'].includes(value))throw new Error(key+' accepts on | off');
  return {[key]:value==='on'};
}

/** Local readiness only. A saved switch and available dependencies do not prove task success. */
export function createFeatureControl(ctx,runtime,{available,canRecall,workingSet,qualityReview,compactionHandoff,retainedCompute,effects}){
  const service=name=>{try{return ctx.get(name);}catch{return null;}};
  async function snapshot(agent,only){
    const state=runtime.get(agent),config=state.config,effective=runtime.isEnabled(agent),selection=runtime.currentSelection(agent);
    const native=service('ptcRuntime'),ptc=(()=>{try{return ctx.tools.modeFor(agent)==='ptc';}catch{return false;}})();
    const nativeCompaction=compactionHandoff.metrics(agent).nativeSummarizerAttached;
    const retained=retainedCompute.summary(agent);
    const observedFeatures=effects?.snapshot(agent,{detail:false}).features??{};
    const archiveDecoder=archiveDecoderStatus();
    let fastEditFiles=null;
    if(config.fastEditEnabled&&(!only||only==='fastEditEnabled')){
      try{await Promise.all([fs.access(config.fastEditPython),fs.access(path.join(import.meta.dirname,'fastedit-bridge.py'))]);fastEditFiles=true;}
      catch{fastEditFiles=false;}
    }
    const features=DEFINITIONS.filter(([key])=>!only||key===only).map(([key,label,purpose,choices])=>{
      const configured=config[key],reasons=[];let status='ready';
      const effectiveValue=key==='enabled'?state.sessionEnabledOverride??configured:
        key==='defaultResponseView'?state.sessionDefaultResponseView??configured:configured;
      if(key==='enabled'&&!state.workspaceConfigValid){status='blocked';reasons.push('workspace-config-unavailable');}
      else if(key==='enabled'&&configured&&state.sessionEnabledOverride===false){status='blocked';reasons.push('session-disabled');}
      else if(effectiveValue===false)status='off';
      else if(!effective){
        status='blocked';reasons.push(!state.workspaceConfigValid?'workspace-config-unavailable':
          (state.sessionEnabledOverride??config.enabled)===false?'plugin-disabled':'aggressive-off-and-no-ultra');
      }
      if(status==='ready'){
        for(const dependency of REQUIRES[key]??[])if(!config[dependency])reasons.push('requires-setting:'+dependency);
        if(['swEviction','requestProjection','projectionRestore','ledgerReceipt','historyHygiene','stubSummary'].includes(key)&&canRecall(agent)!==true)reasons.push('historical-recall-not-exposed');
        if(['stubSummary','deferPressureCompaction'].includes(key)&&!nativeCompaction)reasons.push('native-compaction-not-attached');
        if(['nativeProgramReuse','structuredCalls'].includes(key)&&!ptc)reasons.push('requires-ptc-tool-mode');
        if(key==='structuredCalls'&&(native?.language!=='typescript'||native?.programFormat!=='function-body'))reasons.push('requires-typescript-function-body-runtime');
        if(['archiveReadRouting','memberParsing','mavenSourceBinding'].includes(key)&&!service('fs'))reasons.push('native-filesystem-unavailable');
        if(['archiveReadRouting','mavenSourceBinding'].includes(key)&&!archiveDecoder.available)reasons.push('archive-decoder-unavailable:fflate');
        if(key==='fastEditEnabled'){
          if(!fastEditFiles)reasons.push('fastedit-runtime-files-unavailable');
          if(!available(agent,'ops_stat'))reasons.push('tool-unavailable:ops_stat');
          if(!['pwsh','ops_bash','bash'].some(tool=>available(agent,tool)))reasons.push('authorized-shell-unavailable');
        }
        if(['requestProjection','projectionRestore'].includes(key)&&workingSet.metrics(agent).adapter==='unavailable')reasons.push('projection-adapter-unavailable');
        if(key==='qualityReview'&&(!selection?.provider||!selection?.model))reasons.push('main-model-route-unavailable');
        if(key==='retainedCompute')for(const name of retained.missingDependencies)reasons.push('native-service-unavailable:'+name);
        if(reasons.length)status='blocked';
        else if(key==='retainedCompute'&&retained.loadFailure){status='waiting';reasons.push('retained-runtime-retry-on-next-call');}
        else if(key==='nativeReasoningReplay'&&!/(?:^|\/)deepseek-/iu.test(selection?.model??'')){status='waiting';reasons.push('requires-matching-deepseek-tool-history');}
        else if(key==='qualityReview'&&runtime.modeStatus(agent).selected!=='quality'){status='waiting';reasons.push('requires-ultra-quality-mode');}
        else if(key==='qualityReview'){
          const review=qualityReview.summary(agent);
          if(['paused','unavailable'].includes(review.status)){status='blocked';reasons.push(review.paused?.reason??review.process?.last?.reason??review.storageError??review.readError??'review-route-paused');}
          else if(review.waitingReason){status='waiting';reasons.push(review.waitingReason);}
          else if(state.taskSurfaceMode==='minimal'){status='waiting';reasons.push('minimal-task-does-not-request-review');}
        }else if(key==='stepPacing'&&state.taskSurfaceMode==='minimal'){status='waiting';reasons.push('minimal-task-needs-no-guidance');}
      }
      if(key==='enabled'&&state.sessionEnabledOverride===true&&configured===false)reasons.push('session-override-on');
      const counters=Object.entries(observedFeatures).filter(([name])=>featureSetting(name)===key).map(([,item])=>item);
      const count=field=>counters.reduce((sum,item)=>sum+(item[field]??0),0);
      const effectStatus=!counters.length||count('decisions')===0?'not-observed':count('applied')&&count('failed')?'mixed':
        count('applied')?'applied':count('failed')?'failed':count('notApplicable')?'not-applicable':'not-applied';
      const last=counters.findLast(item=>item.lastStatus&&item.lastStatus!=='not-observed');
      return {key,label,purpose,configured,packageDefault:PACKAGE_DEFAULTS[key],status,reasons,
        effect:{status:effectStatus,decisions:count('decisions'),applied:count('applied'),failed:count('failed'),
          deferred:count('deferred'),notApplicable:count('notApplicable'),unavailable:count('unavailable'),
          lastStatus:last?.lastStatus??'not-observed',lastReason:last?.lastReason??(counters.length?'no-effect-applied':'no-dedicated-effect-counter'),
          coverage:'recorded-dedicated-effect-counters-only; readiness and task quality are separate'},
        ...(['enabled','defaultResponseView'].includes(key)?{effectiveValue}:{}),
        entry:'/work-evidence feature '+key+' '+(choices?choices.join('|'):'on|off'),
        scope:'workspace',...(choices?{choices}:{})};
    });
    return {version:VERSION,scope:'workspace',path:state.dir?path.join(state.dir,'config.json'):null,pluginEffective:effective,
      sessionEnabledOverride:state.sessionEnabledOverride,mode:runtime.modeStatus(agent),
      dependencies:{fastEditPython:config.fastEditPython,archiveDecoder,ptcToolMode:ptc,nativeCompactionAttached:nativeCompaction,ptcRuntime:native?{language:native.language,programFormat:native.programFormat}:null,
        model:selection?{provider:selection.provider,model:selection.model}:null,retainedCompute:retained},
      features,tools:only?undefined:TOOLS.map(name=>({name,exposed:available(agent,name),entry:available(agent,name)?name:'/work-evidence feature toolSurface full'})),
      note:'状态只说明配置与当前可检查的条件，不等于功能已触发或任务结果正确。FastEdit 的 Python 包由实际调用确认；上游是否接受推理字段沿用通道实际依据。'};
  }
  return {snapshot,async summary(agent){
    const value=await snapshot(agent);
    return {entry:'/work-evidence features',ready:value.features.filter(item=>item.status==='ready').length,
      off:value.features.filter(item=>item.status==='off').length,
      blocked:value.features.filter(item=>item.status==='blocked').map(({key,reasons})=>({key,reasons})),
      waiting:value.features.filter(item=>item.status==='waiting').map(({key,reasons})=>({key,reasons})),
      scope:'local-readiness-only; actual effects are recorded separately'};
  }};
}
