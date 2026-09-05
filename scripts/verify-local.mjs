// Read-only HTTP smoke check of the running service; creates only an admin session.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
const origin=process.env.INKSTACK_ORIGIN??'http://127.0.0.1:3210';
const password=process.env.INKSTACK_ADMIN_PASSWORD??readFileSync('.local/admin-password.txt','utf8').trim();
const login=await fetch(`${origin}/api/session`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password})});
if(login.status!==200)throw Error(`Login failed (${login.status})`);
const cookie=login.headers.getSetCookie()[0].split(';')[0];
try {
  const draftResponse=await fetch(`${origin}/api/dashboards/main`,{headers:{cookie}});
  if(!draftResponse.ok)throw Error('Dashboard unavailable');
  const dashboard=await draftResponse.json();
  const url=readFileSync('.local/browser-display-url.txt','utf8').trim();
  if(new URL(url).origin!==origin)throw Error('Display URL must belong to the local test service');
  const first=await fetch(url);
  if(first.status!==200)throw Error(`Display failed (${first.status})`);
  const bytes=Buffer.from(await first.arrayBuffer());
  const meta=await sharp(bytes).metadata();
  if(meta.format!=='png'||meta.channels!==1||meta.hasAlpha||bytes[24]!==8||bytes[25]!==0)throw Error('Invalid grayscale PNG');
  const second=await fetch(url,{headers:{'if-none-match':first.headers.get('etag')}});
  if(second.status!==304||(await second.arrayBuffer()).byteLength!==0)throw Error('Conditional request failed');
  const unauthorized=await fetch(`${origin}/api/dashboards/main`);
  if(unauthorized.status!==401)throw Error('Admin authorization failed');
  mkdirSync('data/verification',{recursive:true});
  writeFileSync('data/verification/published.png',bytes);
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),draftRevision:dashboard.draftRevision,publishedRevision:dashboard.publishedRevision,widgets:dashboard.draft.widgets.length,png:{width:meta.width,height:meta.height,channels:meta.channels,hasAlpha:meta.hasAlpha,sha256:createHash('sha256').update(bytes).digest('hex')},http:[first.status,second.status,unauthorized.status]},null,2));
} finally {
  await fetch(`${origin}/api/session`,{method:'DELETE',headers:{origin,cookie}});
}
