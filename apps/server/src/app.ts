import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { widgetCatalog } from '@ink-stack/widgets';
import type { DashboardDraft, WidgetDataEnvelope } from '@ink-stack/shared';
import { openDatabase } from './storage/database.js';
import { installAuth, digest } from './auth.js';
import { Connections } from './data/connections.js';
import { DashboardService, HttpError, type ServiceOptions } from './services/dashboard.js';
import type { CodexLimitsResult } from './connectors/codex-app-server.js';
import { collectWidgetData } from './services/widget-data.js';
import { ImageManager } from './services/images.js';
import { GoogleCalendarService, type GoogleHttp } from './services/google-calendar.js';
import type { QWeatherTransport } from '@ink-stack/widgets/weather/server';

export interface AppOptions {
  directory:string; password:string; origin?:string; fontPath?:string; webRoot?:string;
  reader?:()=>Promise<CodexLimitsResult>; renderer?:ServiceOptions['renderer'];
  dataProvider?:(d:DashboardDraft)=>Promise<Record<string,WidgetDataEnvelope>>;
  masterKey?:Buffer; weatherTransport?:QWeatherTransport; weatherTestTransport?:QWeatherTransport; googleHttp?:GoogleHttp;
  refreshMs?:number; initialCycleSeconds?:number;
}
const objectSchema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',additionalProperties:false,properties,required});
const integer={type:'integer',minimum:0};
const emptySettings=objectSchema({});
const connectionBody=objectSchema({name:{type:'string',minLength:1,maxLength:80},type:{const:'codex-local',type:'string'},settings:emptySettings},['name','type','settings']);
const weatherConnectionBody=objectSchema({name:{type:'string',minLength:1,maxLength:80},apiHost:{type:'string',minLength:1,maxLength:253},authMode:{type:'string',enum:['jwt','api-key']},apiKey:{type:'string',minLength:1,maxLength:8192}},['name','apiHost','authMode','apiKey']);
const weatherTestBody=objectSchema({connectionId:{type:'string',maxLength:80},connectionRevision:integer,config:{type:'object',additionalProperties:true},apiHost:{type:'string',maxLength:253},authMode:{type:'string',enum:['jwt','api-key']},apiKey:{type:'string',maxLength:8192}},['config']);

export async function createApp(options:AppOptions){
  const app=Fastify({logger:false,bodyLimit:128*1024,ajv:{customOptions:{coerceTypes:false,removeAdditional:false,useDefaults:false,allErrors:false}}});
  app.addContentTypeParser(/^image\/(?:png|jpeg|webp)$/, {parseAs:'buffer',bodyLimit:16*1024*1024}, (_request,body,done)=>done(null,body));
  const db=openDatabase(options.directory);
  const connections=new Connections(db,options.reader,{masterKey:options.masterKey,weatherTransport:options.weatherTransport,weatherTestTransport:options.weatherTestTransport});
  const imageManager=new ImageManager(db,options.directory);
  await imageManager.init();
  const googleCalendar=new GoogleCalendarService(db,connections,{http:options.googleHttp});
  const service=new DashboardService(db,connections,{directory:options.directory,fontPath:options.fontPath??resolve('assets/fonts/NotoSansCJKsc-Regular.otf'),renderer:options.renderer,imageManager,dataProvider:options.dataProvider??(d=>collectWidgetData(d,connections,googleCalendar,imageManager))});
  if(options.initialCycleSeconds!==undefined)service.setSchedule({enabled:true,cycleSeconds:options.initialCycleSeconds});
  await service.recover();
  const origin=options.origin??'http://127.0.0.1:3210';
  await installAuth(app,options.password,origin,origin.startsWith('https:'));
  app.addHook('onSend',async(_request,reply,payload)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('X-Frame-Options','DENY');
    reply.header('Content-Security-Policy',"default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });
  app.setErrorHandler((error,_request,reply)=>{
    const e=error as Error&{statusCode?:number;validation?:unknown};
    const status=e.statusCode??500;
    return reply.code(status).send({error:e instanceof HttpError?e.message:e.validation?'invalid_request':status===429?'rate_limited':status>=500?'internal_error':'invalid_request'});
  });
  app.get('/healthz',async()=>({ok:true}));
  app.get('/api/widget-types',async()=>({widgets:widgetCatalog}));
  app.get('/api/dashboards/main',async()=>service.state());
  app.put<{Body:{dashboard:unknown;baseRevision:number}}>('/api/dashboards/main/draft',{schema:{body:objectSchema({dashboard:{type:'object',additionalProperties:true},baseRevision:integer},['dashboard','baseRevision'])}},async r=>service.save(r.body.dashboard,r.body.baseRevision));
  app.post<{Body:{dashboard:unknown;editorRevision:number}}>('/api/dashboards/main/preview',{schema:{body:objectSchema({dashboard:{type:'object',additionalProperties:true},editorRevision:integer},['dashboard','editorRevision'])},config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(r,reply)=>reply.code(202).send(service.enqueue('preview',r.body.dashboard,undefined,r.body.editorRevision)));
  app.post<{Body:{draftRevision:number}}>('/api/dashboards/main/publish',{schema:{body:objectSchema({draftRevision:integer},['draftRevision'])},config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(r,reply)=>reply.code(202).send(service.enqueue('publish',undefined,r.body.draftRevision)));
  app.get<{Params:{id:string}}>('/api/jobs/:id',async r=>service.job(r.params.id));
  app.get<{Params:{id:string}}>('/api/previews/:id.png',async(r,reply)=>{const p=service.preview(r.params.id);return reply.type('image/png').send(await readFile(p.path));});
  app.get<{Params:{id:string}}>('/api/snapshots/:id.png',async(r,reply)=>{
    const snapshot=service.snapshot(r.params.id);
    if(!snapshot)throw new HttpError(404,'snapshot_not_found');
    return reply.type('image/png').send(await readFile(service.imagePath(snapshot.hash)));
  });
  app.post('/api/display-token',async()=>{const token=randomBytes(32).toString('base64url');db.prepare("UPDATE dashboard SET display_hash=? WHERE id='main'").run(digest(token));return {url:`/display/${token}.png`};});
  app.get<{Params:{token:string}}>('/display/:token.png',async(r,reply)=>{
    if(digest(r.params.token)!==service.row().display_hash)throw new HttpError(404,'display_not_found');
    const published=service.display();
    const etag=`"${published.hash}"`;
    db.prepare("UPDATE dashboard SET last_display_request=? WHERE id='main'").run(new Date().toISOString());
    reply.header('ETag',etag).header('Cache-Control','private, no-cache');
    if(r.headers['if-none-match']?.split(',').some(v=>v.trim()==='*'||v.trim().replace(/^W\//,'')===etag))return reply.code(304).send();
    try{return reply.type('image/png').send(await readFile(published.path));}catch{throw new HttpError(503,'display_unavailable');}
  });
  app.get('/api/data-sources',async()=>({connections:connections.list(),groups:connections.groups(),lastRead:connections.latest()}));
  app.post<{Body:{name:string;type:'codex-local';settings:Record<string,never>}}>('/api/data-sources',{schema:{body:connectionBody}},async(r,reply)=>reply.code(201).send(connections.create(r.body.name)));
  app.post<{Params:{id:string};Body:{settings:Record<string,never>}}>('/api/data-sources/:id/versions',{schema:{body:objectSchema({settings:emptySettings},['settings'])}},async(r,reply)=>{
    if(!connections.list().some(c=>c.id===r.params.id))throw new HttpError(404,'connection_not_found');
    return reply.code(201).send(connections.version(r.params.id));
  });
  const testBody=objectSchema({connectionId:{type:'string',maxLength:80},connectionRevision:integer,type:{const:'codex-local',type:'string'},settings:emptySettings});
  app.post<{Body:{connectionId?:string;connectionRevision?:number}}>('/api/data-sources/test',{schema:{body:testBody},config:{rateLimit:{max:4,timeWindow:'1 minute'}}},async r=>{
    if(r.body.connectionId&&!connections.get(r.body.connectionId,r.body.connectionRevision??1))throw new HttpError(400,'connection_reference_invalid');
    const result=await connections.read(true);return {...connections.latest(),groups:connections.groups(result)};
  });
  app.post<{Params:{id:string}}>('/api/data-sources/:id/refresh',{schema:{body:emptySettings},config:{rateLimit:{max:4,timeWindow:'1 minute'}}},async r=>{
    if(!connections.list().some(c=>c.id===r.params.id))throw new HttpError(404,'connection_not_found');
    const result=await connections.read(true);return {...connections.latest(),groups:connections.groups(result)};
  });
  app.delete<{Params:{id:string}}>('/api/data-sources/:id',async r=>{
    const row=service.row();
    // Include historical published snapshots: recovery must retain resolvable references.
    const history=db.prepare('SELECT config FROM snapshots').all() as {config:string}[];
    try{connections.remove(r.params.id,[JSON.parse(row.draft),...(row.published?[JSON.parse(row.published)]:[]),...history.map(h=>JSON.parse(h.config))]);}catch{throw new HttpError(409,'connection_in_use');}
    return {ok:true};
  });
  app.get('/api/weather-connections',async()=>({connections:connections.listWeather()}));
  app.post<{Body:{name:string;apiHost:string;authMode:'jwt'|'api-key';apiKey:string}}>('/api/weather-connections',{schema:{body:weatherConnectionBody}},async(r,reply)=>{
    try { return reply.code(201).send(connections.createWeather(r.body)); }
    catch(error) {
      if(error instanceof Error && error.message==='master_key_unavailable') throw new HttpError(503,'master_key_unavailable');
      throw new HttpError(400,error instanceof Error && error.message==='invalid_weather_connection'?'invalid_weather_connection':'weather_connection_unavailable');
    }
  });
  app.post<{Params:{id:string};Body:{revision:number;apiKey:string}}>('/api/weather-connections/:id/rotate',{schema:{body:objectSchema({revision:integer,apiKey:{type:'string',minLength:1,maxLength:8192}},['revision','apiKey'])}},async(r,reply)=>{
    try { return reply.code(201).send(connections.rotateWeatherCredential(r.params.id,r.body.revision,r.body.apiKey)); }
    catch(error) {
      if(error instanceof Error && error.message==='master_key_unavailable') throw new HttpError(503,'master_key_unavailable');
      throw new HttpError(400,error instanceof Error && error.message==='invalid_weather_connection'?'invalid_weather_connection':'weather_connection_unavailable');
    }
  });
  app.post<{Body:{connectionId?:string;connectionRevision?:number;config:Record<string,unknown>;apiHost?:string;authMode?:'jwt'|'api-key';apiKey?:string}}>('/api/weather-connections/test',{schema:{body:weatherTestBody},config:{rateLimit:{max:8,timeWindow:'1 minute'}}},async r=>{
    const config=r.body.config as unknown as import('@ink-stack/widgets/weather/types').WeatherConfig;
    let envelope;
    if(r.body.connectionId) {
      if(!connections.getWeatherPublic(r.body.connectionId,r.body.connectionRevision??1)) throw new HttpError(400,'connection_reference_invalid');
      envelope=await connections.testWeather({...config,connectionId:r.body.connectionId,connectionRevision:r.body.connectionRevision??1});
    } else {
      if(!r.body.apiHost||!r.body.authMode||!r.body.apiKey) throw new HttpError(400,'weather_connection_required');
      envelope=await connections.testWeather(config,{name:'temporary',apiHost:r.body.apiHost,authMode:r.body.authMode,apiKey:r.body.apiKey});
    }
    return {status:envelope.status,reason:envelope.reason,observedAt:envelope.observedAt,message:weatherEnvelopeMessage(envelope),summary:envelope.data?{location:envelope.data.location,temperature:envelope.data.temperature,condition:envelope.data.condition,feelsLike:envelope.data.feelsLike,humidity:envelope.data.humidity,windSpeed:envelope.data.windSpeed,forecastCount:envelope.data.forecast.length}:undefined};
  });
  const imageSourceBody=objectSchema({type:{type:'string',enum:['album','directory']},name:{type:'string',minLength:1,maxLength:80},root:{type:'string',maxLength:4096}},['type','name']);
  app.get('/api/image-sources',async()=>({sources:imageManager.list()}));
  app.post<{Body:{type:'album'|'directory';name:string;root?:string}}>('/api/image-sources',{schema:{body:imageSourceBody}},async(r,reply)=>{
    try { return reply.code(201).send(await imageManager.create(r.body)); }
    catch(error) { throw new HttpError(400,error instanceof Error && error.message.startsWith('invalid_')?error.message:'image_source_unavailable'); }
  });
  app.get<{Params:{id:string};Querystring:{revision:string;recursive?:string}}>('/api/image-sources/:id/images',{schema:{querystring:objectSchema({revision:{type:'string',pattern:'^[1-9][0-9]*$'},recursive:{type:'string',enum:['true','false']}},['revision'])}},async r=>{
    try { return await imageManager.listImages(r.params.id,Number(r.query.revision),r.query.recursive!=='false'); }
    catch(error) { throw new HttpError(404,error instanceof Error && error.message==='image_source_not_found'?'image_source_not_found':'image_source_inaccessible'); }
  });
  app.post<{Params:{id:string};Headers:{'x-inkstack-filename'?:string};Body:Buffer}>('/api/image-sources/:id/uploads',async(r,reply)=>{
    try { return reply.code(201).send(await imageManager.upload(r.params.id,r.headers['x-inkstack-filename']??'',r.body)); }
    catch(error) { throw new HttpError(error instanceof Error && error.message==='image_source_not_found'?404:400,error instanceof Error?error.message:'image_upload_failed'); }
  });
  app.delete<{Params:{id:string}}>('/api/image-sources/:id',async r=>{
    const row=service.row();const history=db.prepare('SELECT config FROM snapshots').all() as {config:string}[];
    try { imageManager.remove(r.params.id,[JSON.parse(row.draft),...(row.published?[JSON.parse(row.published)]:[]),...history.map(h=>JSON.parse(h.config))]); }
    catch(error) { throw new HttpError(error instanceof Error && error.message==='image_source_not_found'?404:409,error instanceof Error?error.message:'image_source_in_use'); }
    return {ok:true};
  });
  const googleAppBody=objectSchema({clientId:{type:'string',minLength:8,maxLength:256},clientSecret:{type:'string',minLength:1,maxLength:8192}},['clientId','clientSecret']);
  app.get('/api/google/status',async()=>({app:googleCalendar.appStatus(),connections:googleCalendar.listConnections()}));
  app.put<{Body:{clientId:string;clientSecret:string}}>('/api/google/app',{schema:{body:googleAppBody}},async(r,reply)=>{
    try { return reply.send(googleCalendar.setApp(r.body.clientId,r.body.clientSecret)); }
    catch(error) { if(error instanceof Error&&error.message==='master_key_unavailable') throw new HttpError(503,'master_key_unavailable'); throw new HttpError(400,'invalid_google_app'); }
  });
  app.get('/api/google/oauth/start',async(r,reply)=>{
    const token=r.cookies.ink_session;
    if(!token) throw new HttpError(401,'authentication_required');
    try { return reply.send({url:await googleCalendar.start(digest(token),origin)}); }
    catch { throw new HttpError(400,'google_app_not_configured'); }
  });
  app.get<{Querystring:{state?:string;code?:string;error?:string}}>('/api/google/oauth/callback',async(r,reply)=>{
    const token=r.cookies.ink_session;
    if(!token) throw new HttpError(401,'authentication_required');
    if(r.query.error || !r.query.state || !r.query.code) return reply.redirect('/?google=denied');
    try {
      await googleCalendar.complete(digest(token),r.query.state,r.query.code,origin);
      return reply.redirect('/?google=connected');
    } catch { return reply.redirect('/?google=error'); }
  });
  app.get<{Params:{id:string};Querystring:{revision?:string}}>('/api/google/connections/:id/calendars',async r=>{
    const revision=Number(r.query.revision??'1');
    if(!Number.isInteger(revision)||revision<1) throw new HttpError(400,'invalid_connection_revision');
    try { return {calendars:await googleCalendar.listCalendars(r.params.id,revision)}; }
    catch(error) { throw new HttpError(400,error instanceof Error&&error.message==='oauth_state_invalid'?'google_connection_invalid':'google_calendars_unavailable'); }
  });
  app.delete<{Params:{id:string}}>('/api/google/connections/:id',async r=>{
    const row=service.row();const history=db.prepare('SELECT config FROM snapshots').all() as {config:string}[];
    try { await googleCalendar.remove(r.params.id,[JSON.parse(row.draft),...(row.published?[JSON.parse(row.published)]:[]),...history.map(h=>JSON.parse(h.config))]); }
    catch(error) { throw new HttpError(error instanceof Error&&error.message==='connection_not_found'?404:409,error instanceof Error?error.message:'connection_in_use'); }
    return {ok:true};
  });
  app.get('/api/schedule',async()=>service.scheduleState());
  app.put<{Body:{enabled:boolean;cycleSeconds:number}}>('/api/schedule',{schema:{body:objectSchema({enabled:{type:'boolean'},cycleSeconds:{type:'integer',minimum:60,maximum:86400}},['enabled','cycleSeconds'])}},async r=>service.setSchedule(r.body));
  const webRoot=options.webRoot??resolve('apps/web/dist');
  if(existsSync(webRoot))await app.register(fastifyStatic,{root:webRoot,index:'index.html'});
  const explicitRefreshMs=options.refreshMs;
  const timer=explicitRefreshMs===0?undefined:setInterval(()=>{try{if(explicitRefreshMs===undefined)service.schedulerTick();else service.enqueue('refresh');}catch{/* Status is persisted by the task. */}},explicitRefreshMs===undefined?30_000:Math.max(10,explicitRefreshMs));
  timer?.unref();
  app.addHook('onClose',async()=>{if(timer)clearInterval(timer);await service.close();db.close();});
  return {app,service,connections,imageManager,googleCalendar,db};
}

function weatherEnvelopeMessage(envelope: import('@ink-stack/widgets/weather/types').WeatherEnvelope): string {
  if(envelope.status==='fresh') return '天气读取成功';
  if(envelope.status==='stale') return '天气读取成功，但数据已过期';
  switch(envelope.reason) {
    case 'authentication': return '认证失败，请检查 API Key 或 JWT';
    case 'location': return '位置不明确，请改用明确的 Location ID 或经纬度';
    case 'timeout': return '天气服务响应超时';
    case 'network': return '天气服务暂时无法连接';
    case 'response': return '天气服务返回的数据格式不受支持';
    case 'connection': return '天气连接未配置或主密钥不可用';
    default: return '天气暂不可用';
  }
}
