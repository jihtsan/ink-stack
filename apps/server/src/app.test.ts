import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { createApp, type AppOptions } from './app.js';
import { getWidgetDefinition } from '@ink-stack/widgets';
import type {DashboardDraft} from '@ink-stack/shared';
import type {RenderInput} from './workers/render.worker.js';
import {Renderer} from './services/renderer.js';

const origin='http://127.0.0.1:3210',password='test-password-only-123456';
const resources:{app:Awaited<ReturnType<typeof createApp>>;directory:string}[]=[];
afterEach(async()=>{for(const r of resources.splice(0)){await r.app.app.close();rmSync(r.directory,{recursive:true,force:true});}});
async function setup(extra:Partial<AppOptions>={}){
 const directory=mkdtempSync(join(tmpdir(),'ink-test-'));
 const app=await createApp({directory,password,origin,refreshMs:0,renderer:new Renderer(20_000,new URL('../dist/workers/render.worker.js',import.meta.url)),reader:async()=>({status:'not_logged_in',observedAt:new Date().toISOString()}),...extra});
 resources.push({app,directory});
 const login=await app.app.inject({method:'POST',url:'/api/session',headers:{origin},payload:{password}});
 expect(login.statusCode).toBe(200);
 const loginCookie=login.headers['set-cookie']!.toString();
 const cookie=loginCookie.split(';')[0]!;
 const request=(method:'GET'|'PUT'|'POST'|'DELETE',url:string,payload?:unknown)=>app.app.inject({method,url,headers:{origin,cookie},payload:payload as never});
 return {...app,directory,request,loginCookie};
}
function addText(d:DashboardDraft,text='墨栈中文测试',row=0){const definition=getWidgetDefinition('text')!;d.widgets.push({id:`text-${row}`,type:'text',configVersion:1,column:0,row,columnSpan:2,rowSpan:1,config:{...structuredClone(definition.defaults),text}});return d;}
async function publish(ctx:Awaited<ReturnType<typeof setup>>,d:DashboardDraft){const save=await ctx.request('PUT','/api/dashboards/main/draft',{dashboard:d,baseRevision:ctx.service.state().draftRevision});expect(save.statusCode).toBe(200);const r=await ctx.request('POST','/api/dashboards/main/publish',{draftRevision:save.json().draftRevision});await ctx.service.idle();expect(ctx.service.job(r.json().id).status).toBe('succeeded');return r.json().id as string;}

describe('management, rendering and delivery',()=>{
 it('protects management, origin and separate display token; rejects unregistered secrets',async()=>{
  const c=await setup();
  expect(c.loginCookie).toMatch(/HttpOnly/);expect(c.loginCookie).toMatch(/SameSite=Lax/);expect(c.loginCookie).toMatch(/Path=\//);
  expect((await c.app.inject({url:'/api/dashboards/main'})).statusCode).toBe(401);
  expect((await c.app.inject({method:'POST',url:'/api/session',payload:{password},headers:{origin:'http://evil.example'}})).statusCode).toBe(403);
  expect((await c.request('POST','/api/data-sources',{name:'bad',type:'codex-local',settings:{apiKey:'secret'}})).statusCode).toBe(400);
  expect((await c.app.inject({url:'/display/unknown.png'})).statusCode).toBe(404);
  const token=(await c.request('POST','/api/display-token',{})).json();
  expect((await c.app.inject({url:token.url})).statusCode).toBe(503);
  expect(JSON.stringify(c.service.state())).not.toContain(token.url);
 });
 it('rejects overlap, unsupported spans, fractional coordinates, unknown configs and revision conflicts',async()=>{
  const c=await setup();const d=addText(c.service.state().draft);
  const save=await c.request('PUT','/api/dashboards/main/draft',{dashboard:d,baseRevision:1});expect(save.statusCode).toBe(200);
  expect((await c.request('PUT','/api/dashboards/main/draft',{dashboard:d,baseRevision:1})).statusCode).toBe(409);
  for(const change of [()=>{d.widgets.push({...d.widgets[0]!,id:'collision'});},()=>{d.widgets[0]!.columnSpan=3;},()=>{d.widgets[0]!.column=0.5;},()=>{d.widgets[0]!.config.secret='token';}]){
   d.widgets=[structuredClone(save.json().draft.widgets[0])];change();expect((await c.request('PUT','/api/dashboards/main/draft',{dashboard:d,baseRevision:2})).statusCode).toBe(400);
  }
 });
 it('produces Chinese opaque 8-bit grayscale PNG; draft/preview and conditional GET do not change publication',async()=>{
  let reads=0;const c=await setup({dataProvider:async()=>{reads++;return {};}});
  const d=addText(c.service.state().draft);await publish(c,d);
  const token=(await c.request('POST','/api/display-token',{})).json().url;
  const first=await c.app.inject({url:token});expect(first.statusCode).toBe(200);
  const meta=await sharp(first.rawPayload).metadata();expect(meta).toMatchObject({width:600,height:800,channels:1,hasAlpha:false,space:'b-w',depth:'uchar'});
  expect(first.rawPayload[24]).toBe(8);expect(first.rawPayload[25]).toBe(0);
  const latest=addText(c.service.state().draft,'另一个独立实例',2);
  const saved=await c.request('PUT','/api/dashboards/main/draft',{dashboard:latest,baseRevision:2});expect(saved.statusCode).toBe(200);
  const preview=(await c.request('POST','/api/dashboards/main/preview',{dashboard:latest,editorRevision:33})).json();await c.service.idle();
  expect(c.service.job(preview.id)).toMatchObject({status:'succeeded',editorRevision:33});
  expect((await c.app.inject({url:token})).headers.etag).toBe(first.headers.etag);
  const before=reads;
  const cached=await c.app.inject({url:token,headers:{'if-none-match':`"other", W/${first.headers.etag}`}});expect(cached.statusCode).toBe(304);expect(cached.rawPayload.length).toBe(0);expect(reads).toBe(before);
  const rotated=(await c.request('POST','/api/display-token',{})).json().url;expect((await c.app.inject({url:token})).statusCode).toBe(404);expect((await c.app.inject({url:rotated})).statusCode).toBe(200);
 });
 it('keeps a valid previous image on render failure and restores it after corrupt current file/restart',async()=>{
  const c=await setup();await publish(c,addText(c.service.state().draft,'第一张'));
  const old=c.service.state().snapshot!;
  const d=c.service.state().draft;d.widgets[0]!.config.text='第二张';await publish(c,d);
  const current=c.service.state().snapshot!;expect(current.hash).not.toBe(old.hash);
  writeFileSync(c.service.imagePath(current.hash),'not png');await c.service.recover();expect(c.service.state().snapshot!.hash).toBe(old.hash);
  const restoredRevision=c.service.state().draftRevision;
  c.db.prepare("INSERT INTO jobs(id,kind,status,revision,sequence,created_at) VALUES ('interrupted','publish','running',?,99,?)").run(restoredRevision,new Date().toISOString());
  await c.app.close();resources.splice(resources.findIndex(r=>r.app.app===c.app),1);
  const reopened=await createApp({directory:c.directory,password,refreshMs:0,renderer:{render:async()=>{throw Error('failure injection');},close:async()=>{}}});resources.push({app:reopened,directory:c.directory});
  expect(reopened.service.state().draftRevision).toBe(restoredRevision);expect(reopened.service.state().snapshot!.hash).toBe(old.hash);
  expect(reopened.service.job('interrupted')).toMatchObject({status:'failed',error:'interrupted_by_restart'});
  const job=reopened.service.enqueue('publish',undefined,restoredRevision)!;await reopened.service.idle();expect(reopened.service.job(job.id).status).toBe('failed');expect(reopened.service.state().snapshot!.hash).toBe(old.hash);
 });
 it('newer publication supersedes a running old publication; refresh never uses draft',async()=>{
  let release:()=>void=()=>{};let started:()=>void=()=>{};
  const begin=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{release=r;});let count=0;const rendered:string[]=[];
  const renderer={render:async(input:RenderInput)=>{rendered.push(String(input.dashboard.widgets[0]?.config.text));if(++count===1){started();await gate;}return sharp({create:{width:600,height:800,channels:3,background:'#ffffff'}}).toColourspace('b-w').png().toBuffer();},close:async()=>{}};
  const c=await setup({renderer});let d=addText(c.service.state().draft,'旧任务');c.service.save(d,1);const first=c.service.enqueue('publish',undefined,2)!;await begin;
  d=c.service.state().draft;d.widgets[0]!.config.text='新任务';c.service.save(d,2);const second=c.service.enqueue('publish',undefined,3)!;
  expect((await c.app.inject({url:'/healthz'})).statusCode).toBe(200);release();await c.service.idle();
  expect(c.service.job(first.id).status).toBe('superseded');expect(c.service.job(second.id).status).toBe('succeeded');expect(c.service.state().publishedRevision).toBe(3);
  d=c.service.state().draft;d.widgets[0]!.config.text='未发布草稿';c.service.save(d,3);c.service.enqueue('refresh');await c.service.idle();expect(rendered.at(-1)).toBe('新任务');
 });
 it('versions connections without changing published references and rejects referenced deletion',async()=>{
  const c=await setup();const definition=getWidgetDefinition('codex-usage')!;const d=c.service.state().draft;
  d.widgets.push({id:'quota',type:'codex-usage',configVersion:1,column:0,row:0,columnSpan:2,rowSpan:4,config:structuredClone(definition.defaults)});
  await publish(c,d);const before=c.service.state().snapshot!.hash;
  const v=await c.request('POST','/api/data-sources/local-codex-app-server/versions',{settings:{}});expect(v.json().revision).toBe(2);expect(c.service.state().snapshot!.hash).toBe(before);
  expect((await c.request('DELETE','/api/data-sources/local-codex-app-server')).statusCode).toBe(409);
  expect((await c.request('POST','/api/data-sources/test',{connectionId:'missing'})).statusCode).toBe(400);
  const tested=await c.request('POST','/api/data-sources/test',{});expect(tested.json().status).toBe('not_logged_in');
 });
 it('keeps weather secrets server-side, tests unsaved input, and feeds saved v1 data into preview jobs',async()=>{
  const observed=()=>new Date(Date.now()-1000).toISOString();
  const weatherTransport=async({url}:{url:string})=>{
   if(url.includes('/geo/'))return {code:'200',location:[{id:'101010100',name:'北京',lat:'39.90',lon:'116.40'}]};
   if(url.includes('/current/'))return {updateTime:observed(),temperature:{value:24},feelsLike:{value:23},humidity:0.42,wind:{speed:{value:2.4}},condition:{text:'晴'}};
   return {days:[{forecastStartTime:`${new Date().toISOString().slice(0,10)}T00:00:00+08:00`,temperatureMin:{value:17},temperatureMax:{value:27},daytime:{condition:{text:'晴'}}}]};
  };
  const c=await setup({masterKey:Buffer.alloc(32,7),weatherTransport,weatherTestTransport:weatherTransport});
  const created=await c.request('POST','/api/weather-connections',{name:'北京天气',apiHost:'https://h2a9cf3mhs.xy.qweatherapi.com/',authMode:'api-key',apiKey:'WEATHER_SECRET_SENTINEL'});
  expect(created.statusCode).toBe(201);expect(created.json()).toMatchObject({type:'qweather',revision:1,apiVersion:'v1',credentialConfigured:true,apiHost:'h2a9cf3mhs.xy.qweatherapi.com'});expect(JSON.stringify(created.json())).not.toContain('WEATHER_SECRET_SENTINEL');
  for(const apiHost of ['http://h2a9cf3mhs.xy.qweatherapi.com','https://h2a9cf3mhs.xy.qweatherapi.com/path','https://h2a9cf3mhs.xy.qweatherapi.com/?key=not-allowed']){
   const invalid=await c.request('POST','/api/weather-connections',{name:'无效天气',apiHost,authMode:'api-key',apiKey:'WEATHER_SECRET_SENTINEL'});
   expect(invalid.statusCode).toBe(400);
  }
  expect(c.db.prepare('SELECT COUNT(*) AS count FROM credentials').get()).toMatchObject({count:1});expect(JSON.stringify(c.db.prepare('SELECT * FROM credentials').get())).not.toContain('WEATHER_SECRET_SENTINEL');
  const weatherDefinition=getWidgetDefinition('weather')!;
  const savedConfig={...structuredClone(weatherDefinition.defaults),connectionId:created.json().id,connectionRevision:created.json().revision};
  const unsaved={...savedConfig,connectionId:'',connectionRevision:1};
  const beforeJobs=(c.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {count:number}).count;
  const unsavedTest=await c.request('POST','/api/weather-connections/test',{config:unsaved,apiHost:'h2a9cf3mhs.xy.qweatherapi.com',authMode:'api-key',apiKey:'UNSAVED_SECRET_SENTINEL'});
  expect(unsavedTest.statusCode).toBe(200);expect(unsavedTest.json()).toMatchObject({status:'fresh',summary:{location:'北京',temperature:24,condition:'晴'},preview:{status:'fresh',data:{location:'北京',temperature:24,condition:'晴'}}});expect(JSON.stringify(unsavedTest.json())).not.toContain('UNSAVED_SECRET_SENTINEL');
  const pastedHostTest=await c.request('POST','/api/weather-connections/test',{config:unsaved,apiHost:'https://h2a9cf3mhs.xy.qweatherapi.com/',authMode:'api-key',apiKey:'UNSAVED_SECRET_SENTINEL'});
  expect(pastedHostTest.statusCode).toBe(200);expect(pastedHostTest.json()).toMatchObject({status:'fresh',summary:{location:'北京',temperature:24,condition:'晴'},preview:{status:'fresh',data:{location:'北京',temperature:24,condition:'晴'}}});
  expect((c.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {count:number}).count).toBe(beforeJobs);expect(c.connections.listWeather()).toHaveLength(1);
  const dashboard=c.service.state().draft;dashboard.widgets.push({id:'weather-live',type:'weather',configVersion:1,column:0,row:0,columnSpan:2,rowSpan:2,config:savedConfig});
  const preview=await c.request('POST','/api/dashboards/main/preview',{dashboard,editorRevision:8});expect(preview.statusCode).toBe(202);await c.service.idle();
  expect(c.service.job(preview.json().id)).toMatchObject({status:'succeeded'});
  const status=c.db.prepare('SELECT data_status FROM snapshots WHERE id=?').get(preview.json().id) as {data_status:string};expect(JSON.parse(status.data_status)).toMatchObject({'weather-live':{status:'fresh'}});
 });
 it('searches sanitized weather locations and lets a selected location bypass ambiguous city lookup',async()=>{
  const observed=()=>new Date(Date.now()-1000).toISOString();
  const calls:string[]=[];
  const weatherTransport=async({url}:{url:string})=>{
   calls.push(url);
   if(url.includes('/geo/'))return {code:'200',location:[
    {id:'101010100',name:'北京',lat:'39.90',lon:'116.41',adm1:'北京市',adm2:'北京市',country:'中国',rank:'10'},
    {id:'101011600',name:'东城',lat:'39.92',lon:'116.42',adm1:'北京市',adm2:'北京市',country:'中国',rank:'35'}
   ]};
   return {updateTime:observed(),temperature:{value:24},condition:{text:'晴'}};
  };
  const c=await setup({masterKey:Buffer.alloc(32,9),weatherTransport,weatherTestTransport:weatherTransport});
  const searched=await c.request('POST','/api/weather-connections/locations',{query:'北京',apiHost:'https://h2a9cf3mhs.xy.qweatherapi.com/',authMode:'api-key',apiKey:'LOCATION_SECRET_SENTINEL'});
  expect(searched.statusCode).toBe(200);
  expect(searched.json()).toMatchObject({status:'ok',locations:[
   {id:'101010100',name:'北京',latitude:39.9,longitude:116.41,adm1:'北京市',adm2:'北京市'},
   {id:'101011600',name:'东城',latitude:39.92,longitude:116.42,adm1:'北京市',adm2:'北京市'}
  ]});
  expect(JSON.stringify(searched.json())).not.toContain('LOCATION_SECRET_SENTINEL');
  const created=await c.request('POST','/api/weather-connections',{name:'北京天气',apiHost:'https://h2a9cf3mhs.xy.qweatherapi.com/',authMode:'api-key',apiKey:'LOCATION_SECRET_SENTINEL'});
  expect(created.statusCode).toBe(201);
  const savedSearch=await c.request('POST','/api/weather-connections/locations',{connectionId:created.json().id,connectionRevision:created.json().revision,query:'北京'});
  expect(savedSearch.statusCode).toBe(200);
  expect(savedSearch.json()).toMatchObject({status:'ok'});
  expect(savedSearch.json().locations[0]).toMatchObject({id:'101010100',latitude:39.9,longitude:116.41});
  expect(JSON.stringify(savedSearch.json())).not.toContain('LOCATION_SECRET_SENTINEL');
  const selected=searched.json().locations[0];
  calls.length=0;
  const definition=getWidgetDefinition('weather')!;
  const config={...structuredClone(definition.defaults),locationId:selected.id,city:selected.name,latitude:selected.latitude,longitude:selected.longitude,showForecast:false};
  const tested=await c.request('POST','/api/weather-connections/test',{config,apiHost:'https://h2a9cf3mhs.xy.qweatherapi.com/',authMode:'api-key',apiKey:'LOCATION_SECRET_SENTINEL'});
  expect(tested.statusCode).toBe(200);
  expect(tested.json()).toMatchObject({status:'fresh',summary:{location:'北京',temperature:24,condition:'晴'}});
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toContain('/geo/');
 });
 it('manages uploaded albums without exposing roots and protects image references',async()=>{
  const c=await setup();
  const created=await c.request('POST','/api/image-sources',{type:'album',name:'旅行相册'});expect(created.statusCode).toBe(201);expect(created.json()).toMatchObject({type:'album',revision:1,configured:true});expect(JSON.stringify(created.json())).not.toContain(c.directory);
  const png=await sharp({create:{width:32,height:20,channels:3,background:'white'}}).png().toBuffer();
  const upload=await c.app.inject({method:'POST',url:`/api/image-sources/${created.json().id}/uploads`,headers:{origin,cookie:'', 'content-type':'image/png','x-inkstack-filename':'日出.png'},payload:png});
  // The request helper's authenticated cookie is intentionally not reused in
  // the raw upload call above; verify the protected endpoint before retrying.
  expect(upload.statusCode).toBe(401);
  const login=await c.app.inject({method:'POST',url:'/api/session',headers:{origin},payload:{password}});const cookie=login.headers['set-cookie']!.toString().split(';')[0]!;
  const authenticated=await c.app.inject({method:'POST',url:`/api/image-sources/${created.json().id}/uploads`,headers:{origin,cookie,'content-type':'image/png','x-inkstack-filename':'日出.png'},payload:png});
  expect(authenticated.statusCode).toBe(201);
  const images=await c.request('GET',`/api/image-sources/${created.json().id}/images?revision=1&recursive=true`);
  expect(images.statusCode).toBe(200);expect(images.json().images).toMatchObject([{name:'日出.png',width:32,height:20}]);expect(JSON.stringify(images.json())).not.toContain(c.directory);
  const imageDefinition=getWidgetDefinition('image')!;const dashboard=c.service.state().draft;dashboard.widgets.push({id:'image-live',type:'image',configVersion:1,column:0,row:0,columnSpan:2,rowSpan:2,config:{...structuredClone(imageDefinition.defaults),sourceType:'album',sourceId:created.json().id,sourceRevision:1,selection:'sequential'}});
  const preview=await c.request('POST','/api/dashboards/main/preview',{dashboard,editorRevision:9});expect(preview.statusCode).toBe(202);await c.service.idle();expect(c.service.job(preview.json().id)).toMatchObject({status:'succeeded'});
  const dataStatus=c.db.prepare('SELECT data_status FROM snapshots WHERE id=?').get(preview.json().id) as {data_status:string};expect(JSON.parse(dataStatus.data_status)).toMatchObject({'image-live':{status:'fresh'}});
  expect((await c.request('DELETE',`/api/image-sources/${created.json().id}`)).statusCode).toBe(409);
 });
 it('binds Google OAuth state to the admin session, stores tokens encrypted, and reads selected calendars',async()=>{
  const calls:{url:string;headers?:Record<string,string>;body?:string}[]=[];
  const googleHttp=async(request:{url:string;method:'GET'|'POST';headers?:Record<string,string>;body?:string;signal:AbortSignal})=>{
   calls.push({url:request.url,headers:request.headers,body:request.body});
   if(request.url==='https://oauth2.googleapis.com/token')return {status:200,body:{access_token:'ACCESS_TOKEN_SENTINEL',refresh_token:'REFRESH_TOKEN_SENTINEL',expires_in:3600,scope:'https://www.googleapis.com/auth/calendar.readonly'}};
   if(request.url==='https://oauth2.googleapis.com/revoke')return {status:200,body:{}};
   if(request.url.includes('/calendarList'))return {status:200,body:{items:[{id:'primary',summary:'我的日历',primary:true,timeZone:'Asia/Shanghai'}]}};
   return {status:200,body:{items:[{id:'event-1',summary:'中文会议',start:{dateTime:'2026-09-05T10:00:00+08:00'},end:{dateTime:'2026-09-05T11:00:00+08:00'}}]}};
  };
  const c=await setup({masterKey:Buffer.alloc(32,8),googleHttp});
  const appConfig=await c.request('PUT','/api/google/app',{clientId:'1234567890.apps.googleusercontent.com',clientSecret:'GOOGLE_CLIENT_SECRET_SENTINEL'});expect(appConfig.statusCode).toBe(200);expect(appConfig.json()).toMatchObject({configured:true});expect(JSON.stringify(appConfig.json())).not.toContain('GOOGLE_CLIENT_SECRET_SENTINEL');
  const start=await c.request('GET','/api/google/oauth/start');expect(start.statusCode).toBe(200);const authorization=new URL(start.json().url);expect(authorization.origin).toBe('https://accounts.google.com');expect(authorization.searchParams.get('access_type')).toBe('offline');expect(authorization.searchParams.get('response_type')).toBe('code');expect(authorization.searchParams.get('scope')).toContain('calendar.readonly');
  const otherLogin=await c.app.inject({method:'POST',url:'/api/session',headers:{origin},payload:{password}});const otherCookie=otherLogin.headers['set-cookie']!.toString().split(';')[0]!;
  const mismatched=await c.app.inject({method:'GET',url:`/api/google/oauth/callback?state=${encodeURIComponent(authorization.searchParams.get('state')!)}&code=AUTHORIZATION_CODE`,headers:{cookie:otherCookie}});expect(mismatched.statusCode).toBe(302);expect(mismatched.headers.location).toBe('/?google=error');
  const invalidState=await c.request('GET','/api/google/oauth/callback?state=invalid-state&code=AUTHORIZATION_CODE');expect(invalidState.statusCode).toBe(302);expect(invalidState.headers.location).toBe('/?google=error');
  const retry=await c.request('GET','/api/google/oauth/start');const retryAuthorization=new URL(retry.json().url);
  const callback=await c.request('GET',`/api/google/oauth/callback?state=${encodeURIComponent(retryAuthorization.searchParams.get('state')!)}&code=AUTHORIZATION_CODE`);expect(callback.statusCode).toBe(302);expect(callback.headers.location).toBe('/?google=connected');
  const status=await c.request('GET','/api/google/status');expect(status.json().connections).toMatchObject([{type:'google-calendar-oauth',revision:1,configured:true}]);expect(JSON.stringify(status.json())).not.toMatch(/ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET/);
  const connection=status.json().connections[0];const calendars=await c.request('GET',`/api/google/connections/${connection.id}/calendars?revision=${connection.revision}`);expect(calendars.json()).toEqual({calendars:[{id:'primary',summary:'我的日历',primary:true,timeZone:'Asia/Shanghai'}]});
  const calendarDefinition=getWidgetDefinition('calendar')!;const dashboard=c.service.state().draft;dashboard.widgets.push({id:'calendar-live',type:'calendar',configVersion:1,column:0,row:0,columnSpan:4,rowSpan:3,config:{...structuredClone(calendarDefinition.defaults),connectionId:connection.id,connectionRevision:connection.revision,calendarIds:['primary']}});
  const preview=await c.request('POST','/api/dashboards/main/preview',{dashboard,editorRevision:10});expect(preview.statusCode).toBe(202);await c.service.idle();expect(c.service.job(preview.json().id)).toMatchObject({status:'succeeded'});const dataStatus=c.db.prepare('SELECT data_status FROM snapshots WHERE id=?').get(preview.json().id) as {data_status:string};expect(JSON.parse(dataStatus.data_status)).toMatchObject({'calendar-live':{status:'fresh'}});
  expect(calls.some((call)=>call.url.includes('/events?')&&call.headers?.authorization==='Bearer ACCESS_TOKEN_SENTINEL')).toBe(true);expect(calls.find((call)=>call.url.includes('/events?'))?.url).toContain('singleEvents=true');
  const replay=await c.request('GET',`/api/google/oauth/callback?state=${encodeURIComponent(retryAuthorization.searchParams.get('state')!)}&code=AUTHORIZATION_CODE`);expect(replay.statusCode).toBe(302);expect(replay.headers.location).toBe('/?google=error');
 });
 it('refreshes only the published dashboard on the configured cycle and reports scheduler state',async()=>{
  const seen:string[]=[];const c=await setup({renderer:{render:async input=>{seen.push(String(input.dashboard.widgets[0]?.config.text));return sharp({create:{width:600,height:800,channels:3,background:'white'}}).toColourspace('b-w').png().toBuffer();},close:async()=>{}}});
  expect((await c.request('GET','/api/schedule')).json()).toMatchObject({enabled:true,cycleSeconds:900});
  expect((await c.request('PUT','/api/schedule',{enabled:false,cycleSeconds:600})).json()).toMatchObject({enabled:false,cycleSeconds:600});
  expect(c.service.schedulerTick()).toBeNull();
  expect((await c.request('PUT','/api/schedule',{enabled:true,cycleSeconds:600})).json()).toMatchObject({enabled:true,cycleSeconds:600});
  await publish(c,addText(c.service.state().draft,'发布版本'));
  c.db.prepare('UPDATE scheduler_state SET last_attempt=NULL').run();const job=c.service.schedulerTick();expect(job).toMatchObject({kind:'refresh'});await c.service.idle();expect(c.service.job(job!.id).status).toBe('succeeded');expect(c.service.scheduleState().lastSuccessAt).toBeTruthy();expect(new Set(seen)).toEqual(new Set(['发布版本']));
 });
 it('schedules updates using only the published configuration',async()=>{
  const seen:string[]=[];
  const c=await setup({refreshMs:40,renderer:{render:async input=>{
    seen.push(String(input.dashboard.widgets[0]?.config.text));
    return sharp({create:{width:600,height:800,channels:3,background:'white'}}).toColourspace('b-w').png().toBuffer();
  },close:async()=>{}}});
  await publish(c,addText(c.service.state().draft,'已发布内容'));
  const draft=c.service.state().draft;draft.widgets[0]!.config.text='草稿秘密更改';c.service.save(draft,c.service.state().draftRevision);
  await vi.waitFor(()=>expect(seen.length).toBeGreaterThan(1),{timeout:1000,interval:20});
  expect(new Set(seen)).toEqual(new Set(['已发布内容']));
 });
});
