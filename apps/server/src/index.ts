import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';

if(Number(process.versions.node.split('.')[0])!==24)throw new Error('InkStack requires Node.js 24 LTS. See README.');
const privateDirectory=resolve('.local');
mkdirSync(privateDirectory,{recursive:true,mode:0o700});
const passwordFile=resolve(privateDirectory,'admin-password.txt');
if(!process.env.INKSTACK_ADMIN_PASSWORD&&!existsSync(passwordFile))writeFileSync(passwordFile,randomBytes(24).toString('base64url'),{mode:0o600,flag:'wx'});
if(process.platform!=='win32')chmodSync(privateDirectory,0o700);
const password=process.env.INKSTACK_ADMIN_PASSWORD??readFileSync(passwordFile,'utf8').trim();
const masterKeyFile=resolve(privateDirectory,'master-key.bin');
if(!process.env.INKSTACK_MASTER_KEY&&!existsSync(masterKeyFile))writeFileSync(masterKeyFile,randomBytes(32),{mode:0o600,flag:'wx'});
const masterKey=process.env.INKSTACK_MASTER_KEY
  ? Buffer.from(process.env.INKSTACK_MASTER_KEY,'base64url')
  : readFileSync(masterKeyFile);
if(masterKey.length!==32)throw new Error('INKSTACK_MASTER_KEY must decode to exactly 32 bytes');
const port=Number(process.env.PORT??3210);
const host=process.env.HOST??'127.0.0.1';
const origin=process.env.INKSTACK_ORIGIN??`http://${host}:${port}`;
const configuredRefreshSeconds=process.env.INKSTACK_REFRESH_SECONDS;
const initialCycleSeconds=configuredRefreshSeconds===undefined?undefined:Number(configuredRefreshSeconds);
if(initialCycleSeconds!==undefined&&(!Number.isInteger(initialCycleSeconds)||initialCycleSeconds<60||initialCycleSeconds>86400))throw new Error('Refresh interval must be between 60 and 86400 seconds');
const {app}=await createApp({directory:resolve(process.env.INKSTACK_DATA_DIR??'data'),password,origin,initialCycleSeconds,masterKey});
await app.listen({host,port});
console.log(`InkStack running at ${origin}`);
console.log('Administrator password: .local/admin-password.txt (or INKSTACK_ADMIN_PASSWORD).');
const shutdown=async()=>{await app.close();};
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
