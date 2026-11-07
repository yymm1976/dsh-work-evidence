import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {FLASH_PRESET_RULES} from './flash-preset-rules.mjs';

const profile=process.argv.find(value=>value.endsWith('cordis.patch.yml'))||
  (process.env.DSH_PROFILE?.trim()&&path.join(process.env.DSH_PROFILE.trim(),'cordis.patch.yml'))||
  path.join(os.homedir(),'Documents','DSH Desktop','home','profiles','web','cordis.patch.yml');
const original=await fs.readFile(profile,'utf8'),text=original.replace(/\r\n/g,'\n');
let preset=/^- id: preset-ptc\n[\s\S]*?(?=^- id: |$(?![\s\S]))/m.exec(text)?.[0]?.trimEnd();
if(!preset||!/^          mode: ptc$/m.test(preset))throw new Error('Current native PTC composition is unavailable');
preset=preset.replace(/^- id: preset-ptc\n(?:  name: [^\n]*\n)?/,"- id: preset-work-evidence-flash1017\n  name: '@deepseek-ai/dsh-agent-preset'\n")
  .replace(/^    id: ptc$/m,'    id: work-evidence-flash1017\n    name: 工程证据 · Flash1017\n    description: 可选 DeepSeek V4.1 Flash 家族专用PTC；使用DSH原生能力，外部适配器可选，档位及输出上限由会话选择。')
  .replace(/^    description: DSH[^\n]*\n/m,'').replace(/^    order: \d+$/m,'    order: 2');
const rules=FLASH_PRESET_RULES;
const suffix='          suffix: |-\n'+rules.map(rule=>'            '+rule).join('\n')+'\n';
if(/^          suffix: \|-\n(?:            [^\n]*\n)*/m.test(preset))preset=preset.replace(/^          suffix: \|-\n(?:            [^\n]*\n)*/m,suffix);
else preset=preset.replace(/^(          prefix: [^\n]*\n)/m,'$1'+suffix);
preset+="\n      - id: work-evidence-flash1017-route\n        name: '@local/dsh-work-evidence/flash1017-preset'\n";
if(!/name: '@deepseek-ai\/dsh-compaction-basic'/.test(preset))throw new Error('The native preset must retain the native compaction composition');
const bundle=path.join(import.meta.dirname,'cordis.patch.yml'),bundleText=(await fs.readFile(bundle,'utf8')).replace(/\r\n/g,'\n');
const without=bundleText.replace(/^    - id: preset-work-evidence-flash1017\n[\s\S]*?(?=^    - id: |$(?![\s\S]))/m,'').trimEnd();
await fs.writeFile(bundle,without+'\n'+preset.trimEnd().split('\n').map(line=>'    '+line).join('\n')+'\n');
if(process.argv.includes('--activate')){
  const current=await fs.readFile(profile,'utf8');if(current!==original)throw new Error('Profile changed during preset preparation; no profile edit made');
  const withoutCurrent=text.replace(/^- id: preset-work-evidence-flash1017\n[\s\S]*?(?=^- id: |$(?![\s\S]))/m,'').trimEnd();
  await fs.writeFile(profile,withoutCurrent+'\n'+preset);
}
console.log(JSON.stringify({preset:'work-evidence-flash1017',bundle,profileUpdated:process.argv.includes('--activate'),globalDefaultUnchanged:true,source:'current-native-ptc-composition'}));
