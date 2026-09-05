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

export interface AppOptions {
  directory:string; password:string; origin?:string; fontPath?:string; webRoot?:string;
  reader?:()=>Promise<CodexLimitsResult>; renderer?:ServiceOptions['renderer'];
  dataProvider?:(d:DashboardDraft)=>Promise<Record<string,WidgetDataEnvelope>>;
  refreshMs?:number;
}
const objectSchema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',additionalProperties:false,properties,required});
const integer={type:'integer',minimum:0};
const emptySettings=objectSchema({});
const connectionBody=objectSchema({name:{type:'string',minLength:1,maxLength:80},type:{const:'codex-local',type:'string'},settings:emptySettings},['name','type','settings']);

export async function createApp(options:AppOptions){
  const app=Fastify({logger:false,bodyLimit:128*1024,ajv:{customOptions:{coerceTypes:false,removeAdditional:false,useDefaults:false,allErrors:false}}});
  const db=openDatabase(options.directory);
  const connections=new Connections(db,options.reader);
  const service=new DashboardService(db,connections,{directory:options.directory,fontPath:options.fontPath??resolve('assets/fonts/NotoSansCJKsc-Regular.otf'),renderer:options.renderer,dataProvider:options.dataProvider??(d=>collectWidgetData(d,connections))});
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
  const webRoot=options.webRoot??resolve('apps/web/dist');
  if(existsSync(webRoot))await app.register(fastifyStatic,{root:webRoot,index:'index.html'});
  const timer=options.refreshMs===0?undefined:setInterval(()=>{try{service.enqueue('refresh');}catch{/* Status is persisted by the task. */}},options.refreshMs??600_000);
  timer?.unref();
  app.addHook('onClose',async()=>{if(timer)clearInterval(timer);await service.close();db.close();});
  return {app,service,connections,db};
}
