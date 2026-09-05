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
 const cookie=login.headers['set-cookie']!.toString().split(';')[0]!;
 const request=(method:'GET'|'PUT'|'POST'|'DELETE',url:string,payload?:unknown)=>app.app.inject({method,url,headers:{origin,cookie},payload:payload as never});
 return {...app,directory,request};
}
function addText(d:DashboardDraft,text='墨栈中文测试',row=0){const definition=getWidgetDefinition('text')!;d.widgets.push({id:`text-${row}`,type:'text',configVersion:1,column:0,row,columnSpan:2,rowSpan:1,config:{...structuredClone(definition.defaults),text}});return d;}
async function publish(ctx:Awaited<ReturnType<typeof setup>>,d:DashboardDraft){const save=await ctx.request('PUT','/api/dashboards/main/draft',{dashboard:d,baseRevision:ctx.service.state().draftRevision});expect(save.statusCode).toBe(200);const r=await ctx.request('POST','/api/dashboards/main/publish',{draftRevision:save.json().draftRevision});await ctx.service.idle();expect(ctx.service.job(r.json().id).status).toBe('succeeded');return r.json().id as string;}

describe('management, rendering and delivery',()=>{
 it('protects management, origin and separate display token; rejects unregistered secrets',async()=>{
  const c=await setup();
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
