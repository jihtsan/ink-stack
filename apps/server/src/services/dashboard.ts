import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_DASHBOARD_THEME, DEFAULT_GRID_SPEC, DEFAULT_SCREEN_SPEC, validateDashboardDraft, validateDashboardLayout, type DashboardDraft, type WidgetDataEnvelope } from '@ink-stack/shared';
import { supportedSizesByWidgetType, minimumPixelSizeByWidgetType, validateWidgetInstanceConfig } from '@ink-stack/widgets';
import type { InkDatabase } from '../storage/database.js';
import { digest } from '../auth.js';
import { Connections } from '../data/connections.js';
import { Renderer } from './renderer.js';
import type { ImageManager } from './images.js';
import type { RenderInput } from '../workers/render.worker.js';

interface Row {draft:string;draft_revision:number;published:string|null;published_revision:number|null;snapshot:string|null;publication_sequence:number;display_hash:string|null;last_display_request:string|null;last_error:string|null}
interface SnapshotRow {id:string;hash:string;config:string;revision:number;width:number;height:number;generated_at:string;data_status:string}
interface JobRow {id:string;kind:Kind;status:string;revision:number;editor_revision:number|null;sequence:number;snapshot:string|null;error:string|null}
interface SchedulerRow {enabled:number;cycle_seconds:number;last_attempt:string|null;last_success:string|null;last_job_id:string|null;last_error:string|null;updated_at:string}
type Kind='preview'|'publish'|'refresh';
interface Task {id:string;kind:Kind;dashboard:DashboardDraft;revision:number;sequence:number;editorRevision?:number}
export class HttpError extends Error { constructor(public statusCode:number,message:string){super(message);} }
export interface ServiceOptions {directory:string;fontPath:string;renderer?:Pick<Renderer,'render'|'close'>;dataProvider?:(d:DashboardDraft)=>Promise<Record<string,WidgetDataEnvelope>>;imageManager?:ImageManager}

export class DashboardService {
  private running?:Promise<void>;
  private queue:Task[]=[];
  private closing=false;
  private renderer:Pick<Renderer,'render'|'close'>;
  constructor(readonly db:InkDatabase,readonly connections:Connections,private options:ServiceOptions){
    mkdirSync(join(options.directory,'images'),{recursive:true});
    mkdirSync(join(options.directory,'tmp'),{recursive:true});
    this.renderer=options.renderer??new Renderer();
    const initial:DashboardDraft={schemaVersion:1,id:'main',name:'我的墨栈',revision:1,timeZone:'Asia/Shanghai',screen:DEFAULT_SCREEN_SPEC,grid:DEFAULT_GRID_SPEC,theme:DEFAULT_DASHBOARD_THEME,widgets:[]};
    db.prepare('INSERT OR IGNORE INTO dashboard(id,draft,draft_revision) VALUES (?,?,1)').run('main',JSON.stringify(initial));
  }
  row(){return this.db.prepare("SELECT * FROM dashboard WHERE id='main'").get() as Row;}
  state(){const r=this.row();return {draft:JSON.parse(r.draft) as DashboardDraft,draftRevision:r.draft_revision,publishedRevision:r.published_revision,snapshot:r.snapshot?this.snapshot(r.snapshot):null,lastError:r.last_error,displayTokenConfigured:Boolean(r.display_hash),lastDisplayRequestAt:r.last_display_request,schedule:this.scheduleState()};}
  scheduleState(){const row=this.db.prepare('SELECT enabled,cycle_seconds,last_attempt,last_success,last_job_id,last_error,updated_at FROM scheduler_state WHERE id=1').get() as SchedulerRow;return {enabled:Boolean(row.enabled),cycleSeconds:row.cycle_seconds,lastAttemptAt:row.last_attempt,lastSuccessAt:row.last_success,lastJobId:row.last_job_id,lastError:row.last_error,updatedAt:row.updated_at};}
  setSchedule(input:{enabled:boolean;cycleSeconds:number}){if(typeof input.enabled!=='boolean'||!Number.isInteger(input.cycleSeconds)||input.cycleSeconds<60||input.cycleSeconds>86400)throw new HttpError(400,'invalid_schedule');this.db.prepare('UPDATE scheduler_state SET enabled=?,cycle_seconds=?,updated_at=? WHERE id=1').run(input.enabled?1:0,input.cycleSeconds,new Date().toISOString());return this.scheduleState();}
  schedulerTick(){const schedule=this.scheduleState();if(!schedule.enabled)return null;const now=Date.now();const last=schedule.lastAttemptAt?Date.parse(schedule.lastAttemptAt):NaN;if(Number.isFinite(last)&&now-last<schedule.cycleSeconds*1000)return null;const attempted=new Date(now).toISOString();this.db.prepare('UPDATE scheduler_state SET last_attempt=?,last_error=NULL,updated_at=? WHERE id=1').run(attempted,attempted);const job=this.enqueue('refresh');if(job)this.db.prepare('UPDATE scheduler_state SET last_job_id=?,updated_at=? WHERE id=1').run(job.id,attempted);return job;}
  snapshot(id:string){const s=this.db.prepare('SELECT * FROM snapshots WHERE id=?').get(id) as SnapshotRow|undefined;return s?{id:s.id,url:`/api/snapshots/${s.id}.png`,hash:s.hash,width:s.width,height:s.height,generatedAt:s.generated_at,revision:s.revision,dataStatus:JSON.parse(s.data_status)}:null;}
  validate(value:unknown):asserts value is DashboardDraft {
    const schema=validateDashboardDraft(value,{supportedSizesByType:supportedSizesByWidgetType,minimumPixelSizeByType:minimumPixelSizeByWidgetType});
    if(!schema.ok) throw new HttpError(400,'invalid_dashboard_schema');
    const d=value as DashboardDraft;
    if(d.id!=='main') throw new HttpError(400,'invalid_dashboard_id');
    const result=validateDashboardLayout(d.screen,d.grid,d.widgets,{supportedSizesByType:supportedSizesByWidgetType,minimumPixelSizeByType:minimumPixelSizeByWidgetType});
    if(!result.ok) throw new HttpError(400,result.issues[0]!.code);
    for(const w of d.widgets) if(!validateWidgetInstanceConfig(w).ok) throw new HttpError(400,'invalid_widget_config');
    try {this.connections.validate(d);} catch {throw new HttpError(400,'connection_reference_invalid');}
    try {this.options.imageManager?.validate(d);} catch {throw new HttpError(400,'image_source_reference_invalid');}
  }
  save(value:unknown,baseRevision:number){
    this.validate(value);
    const next={...value,revision:baseRevision+1};
    const result=this.db.prepare("UPDATE dashboard SET draft=?,draft_revision=draft_revision+1 WHERE id='main' AND draft_revision=?").run(JSON.stringify(next),baseRevision);
    if(!result.changes) throw new HttpError(409,'draft_revision_conflict');
    return this.state();
  }
  enqueue(kind:Kind, input?:unknown, revision?:number, editorRevision?:number){
    if(this.closing) throw new HttpError(503,'service_closing');
    const row=this.row();
    let dashboard:DashboardDraft;
    if(kind==='preview'){this.validate(input);dashboard=structuredClone(input);}
    else if(kind==='publish'){
      if(revision!==row.draft_revision) throw new HttpError(409,'draft_revision_conflict');
      dashboard=JSON.parse(row.draft) as DashboardDraft;
    } else {
      if(!row.published) return null;
      dashboard=JSON.parse(row.published) as DashboardDraft;
      if(this.queue.some(t=>t.kind==='refresh') || this.db.prepare("SELECT id FROM jobs WHERE kind='refresh' AND status='running'").get()) return null;
    }
    this.validate(dashboard);
    const sequence=kind==='publish'?row.publication_sequence+1:row.publication_sequence;
    const task:Task={id:randomUUID(),kind,dashboard,revision:kind==='refresh'?row.published_revision!:kind==='publish'?row.draft_revision:dashboard.revision,sequence,editorRevision};
    this.db.transaction(()=>{
      if(kind==='publish')this.db.prepare("UPDATE dashboard SET publication_sequence=? WHERE id='main'").run(sequence);
      for(const old of this.queue.filter(t=>t.kind===kind)) this.db.prepare("UPDATE jobs SET status='superseded' WHERE id=?").run(old.id);
      this.db.prepare("INSERT INTO jobs(id,kind,status,revision,editor_revision,sequence,created_at) VALUES (?,?,'queued',?,?,?,?)").run(task.id,kind,task.revision,editorRevision??null,sequence,new Date().toISOString());
    })();
    this.queue=this.queue.filter(t=>t.kind!==kind);
    this.queue.push(task);
    this.queue.sort((a,b)=>({publish:0,refresh:1,preview:2}[a.kind]-{publish:0,refresh:1,preview:2}[b.kind]));
    this.kick();
    return this.job(task.id);
  }
  job(id:string){const j=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow|undefined;if(!j)throw new HttpError(404,'job_not_found');return {id:j.id,kind:j.kind,revision:j.revision,status:j.status,editorRevision:j.editor_revision,error:j.error,previewUrl:j.status==='succeeded'?(j.kind==='preview'?`/api/previews/${j.id}.png`:j.snapshot?`/api/snapshots/${j.snapshot}.png`:undefined):undefined};}
  private kick(){if(!this.running)this.running=this.drain().finally(()=>{this.running=undefined;if(this.queue.length)this.kick();});}
  private async drain(){while(this.queue.length&&!this.closing){const task=this.queue.shift()!;await this.execute(task);}}
  private async execute(task:Task){
    this.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(task.id);
    try {
      const now=new Date().toISOString();
      const data=await this.options.dataProvider?.(task.dashboard)??{};
      const input:RenderInput={dashboard:task.dashboard,data,now,fontPath:this.options.fontPath};
      const png=await this.renderer.render(input);
      const meta=await sharp(png).metadata();
      if(meta.width!==task.dashboard.screen.width||meta.height!==task.dashboard.screen.height||meta.channels!==1||meta.hasAlpha||meta.format!=='png')throw new Error('invalid_png');
      const hash=digest(png), file=this.imagePath(hash),temp=join(this.options.directory,'tmp',`${task.id}.png`);
      if(!existsSync(file)){writeFileSync(temp,png,{flag:'wx',flush:true});renameSync(temp,file);}
      this.db.transaction(()=>{
        const row=this.row();
        const obsolete=task.kind==='publish'?row.publication_sequence!==task.sequence:task.kind==='refresh'&&(row.published_revision!==task.revision||row.publication_sequence!==task.sequence);
        if(obsolete){this.db.prepare("UPDATE jobs SET status='superseded' WHERE id=?").run(task.id);return;}
        this.db.prepare('INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?)').run(task.id,hash,JSON.stringify(task.dashboard),task.revision,meta.width,meta.height,now,JSON.stringify(Object.fromEntries(Object.entries(data).map(([id,d])=>[id,{status:d.status,observedAt:d.observedAt}]))));
        this.db.prepare("UPDATE jobs SET status='succeeded',snapshot=? WHERE id=?").run(task.id,task.id);
        if(task.kind!=='preview')this.db.prepare("UPDATE dashboard SET published=?,published_revision=?,snapshot=?,last_error=NULL WHERE id='main'").run(JSON.stringify(task.dashboard),task.revision,task.id);
        if(task.kind==='refresh')this.db.prepare("UPDATE scheduler_state SET last_success=?,last_error=NULL,updated_at=? WHERE id=1").run(now,now);
      })();
    } catch {
      this.db.prepare("UPDATE jobs SET status='failed',error='render_or_data_failed' WHERE id=?").run(task.id);
      const r=this.row();
      if(task.kind!=='preview'&&r.publication_sequence===task.sequence)this.db.prepare("UPDATE dashboard SET last_error='render_or_data_failed' WHERE id='main'").run();
      if(task.kind==='refresh')this.db.prepare("UPDATE scheduler_state SET last_error='render_or_data_failed',updated_at=? WHERE id=1").run(new Date().toISOString());
    }
  }
  imagePath(hash:string){return join(this.options.directory,'images',`${hash}.png`);}
  preview(id:string){const j=this.db.prepare("SELECT snapshot FROM jobs WHERE id=? AND kind='preview' AND status='succeeded'").get(id) as {snapshot:string}|undefined;if(!j)throw new HttpError(404,'preview_not_found');const s=this.snapshot(j.snapshot)!;return {path:this.imagePath(s.hash),hash:s.hash};}
  display(){const row=this.row();if(!row.snapshot)throw new HttpError(503,'display_not_published');const s=this.snapshot(row.snapshot);if(!s)throw new HttpError(503,'display_unavailable');return {path:this.imagePath(s.hash),hash:s.hash};}
  async recover(){
    const row=this.row();if(!row.snapshot)return;
    const candidates=this.db.prepare("SELECT s.* FROM snapshots s JOIN jobs j ON s.id=j.id WHERE j.kind!='preview' AND j.status='succeeded' ORDER BY s.generated_at DESC,s.rowid DESC").all() as SnapshotRow[];
    for(const s of candidates){
      try {const bytes=readFileSync(this.imagePath(s.hash));const meta=await sharp(bytes).metadata();if(digest(bytes)!==s.hash||meta.format!=='png'||meta.width!==s.width||meta.height!==s.height||meta.channels!==1||meta.hasAlpha)continue;
        this.db.prepare("UPDATE dashboard SET published=?,published_revision=?,snapshot=?,last_error=? WHERE id='main'").run(s.config,s.revision,s.id,s.id===row.snapshot?row.last_error:'recovered_previous_snapshot');return;
      }catch{/* Try the previous fully published version. */}
    }
    this.db.prepare("UPDATE dashboard SET snapshot=NULL,last_error='no_valid_snapshot' WHERE id='main'").run();
  }
  async idle(){await this.running;}
  async close(){this.closing=true;for(const t of this.queue)this.db.prepare("UPDATE jobs SET status='failed',error='service_stopped' WHERE id=?").run(t.id);this.queue=[];await this.running;await this.renderer.close();}
}
