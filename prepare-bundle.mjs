import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mount once at the host so preset changes cannot silently remove the plugin.
// Retain the former preset identity for existing sessions, without a second copy.
const profile=process.env.DSH_PROFILE?.trim();
const source = process.argv[2] || (profile&&path.join(profile,'cordis.patch.yml')) ||
  path.join(os.homedir(),'Documents','DSH Desktop','home','profiles','web','cordis.patch.yml');
const text = (await fs.readFile(source, 'utf8')).replace(/\r\n/g, '\n');
const match = /^- id: preset-ptc\n[\s\S]*?(?=^- id: |$(?![\s\S]))/m.exec(text);
if (!match) throw new Error('Current PTC preset row was not found in ' + source);
let preset = match[0].trimEnd();
if (!/^      - id: tool-presentation$/m.test(preset) || !/^          mode: ptc$/m.test(preset)) {
  throw new Error('Expected native PTC tool presentation is missing');
}
preset = preset.replace(/^- id: preset-ptc\n(?:  name: [^\n]*\n)?/, "- id: preset-work-evidence-ptc\n  name: '@deepseek-ai/dsh-agent-preset'\n");
preset = preset.replace(/^    id: ptc$/m,
  '    id: work-evidence-ptc');
preset = preset.replace(/^    name: .*\n/gm, '');
preset = preset.replace(/^    description: .*\n/gm, '');
preset = preset.replace(/^    id: work-evidence-ptc$/m,
  '    id: work-evidence-ptc\n    name: 旧会话兼容 · 工程证据\n    description: 仅保留旧会话接续；新任务使用DSH原生PTC，工程证据已在宿主常驻。');
preset = preset.replace(/^    order: \d+$/m, '    order: 90');
if (!/^    id: work-evidence-ptc$/m.test(preset)) throw new Error('Preset identity could not be rewritten');
if (/name: ['"]?@local\/dsh-work-evidence/.test(preset)) throw new Error('PTC must not also mount the host plugin');
const output = path.join(import.meta.dirname, 'cordis.patch.yml');
const existing = await fs.readFile(output, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const flash = [...existing.matchAll(/^    - id: preset-work-evidence-flash1017(?:-workflow012)?\n[\s\S]*?(?=^    - id: |$(?![\s\S]))/gm)].map(match=>match[0]).join('');
const patch = "- insert:\n    - id: work-evidence-local\n      name: '@local/dsh-work-evidence'\n      disabled: false\n" + preset.split('\n').map(line => line ? '    ' + line : '').join('\n') + '\n';
await fs.writeFile(output, patch + flash);
console.log(JSON.stringify({source, output, mount: 'host', compatibilityPreset: 'work-evidence-ptc', profileModified: false}));
