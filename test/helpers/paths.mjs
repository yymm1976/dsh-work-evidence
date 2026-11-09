import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home=os.homedir();
const resolveOverride=(value,fallback,allowBare=false)=>{
  const text=value?.trim();
  if(!text)return path.resolve(fallback);
  if(path.isAbsolute(text)||text.includes('/')||text.includes('\\'))return path.resolve(text);
  return allowBare?text:path.resolve(text);
};

export const DSH_APP=resolveOverride(process.env.DSH_APP,path.join(home,'AppData','Local','Programs','DSH Desktop','dsh-desktop'));
export const DSH_PROFILE=resolveOverride(process.env.DSH_PROFILE,path.join(home,'Documents','DSH Desktop','home','profiles','web'));
export const DSH_PYTHON=resolveOverride(process.env.DSH_TEST_PYTHON,path.join(home,'Documents','DSH Desktop','runtime','python312','python.exe'),true);
/** A bare interpreter name (for example `python.exe`) resolves through PATH,
 *  not the checkout directory. Use this for test skip conditions. */
export const pythonAvailable=()=>{
  if(path.isAbsolute(DSH_PYTHON)||/[\\/]/u.test(DSH_PYTHON))return fs.existsSync(DSH_PYTHON);
  const extensions=process.platform==='win32'?['',...(process.env.PATHEXT||'.EXE').split(';')]:[''];
  return (process.env.PATH||'').split(path.delimiter).some(directory=>
    extensions.some(extension=>fs.existsSync(path.join(directory,DSH_PYTHON+extension))));
};
export const ACP_ENTRY=path.join(DSH_PROFILE,'node_modules','billion-context-dsh','dist','index.js');
export const OPS_ROOT=path.join(DSH_PROFILE,'node_modules','dsh-ops','lib','components');
