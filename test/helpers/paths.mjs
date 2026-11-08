import os from 'node:os';
import path from 'node:path';

const home=os.homedir();

export const DSH_APP=path.resolve(process.env.DSH_APP?.trim()||path.join(home,'AppData','Local','Programs','DSH Desktop','dsh-desktop'));
export const DSH_PROFILE=path.resolve(process.env.DSH_PROFILE?.trim()||path.join(home,'Documents','DSH Desktop','home','profiles','web'));
export const DSH_PYTHON=path.resolve(process.env.DSH_TEST_PYTHON?.trim()||path.join(home,'Documents','DSH Desktop','runtime','python312','python.exe'));
export const ACP_ENTRY=path.join(DSH_PROFILE,'node_modules','billion-context-dsh','dist','index.js');
export const OPS_ROOT=path.join(DSH_PROFILE,'node_modules','dsh-ops','lib','components');
