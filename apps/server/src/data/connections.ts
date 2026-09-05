import { randomUUID } from 'node:crypto';
import type { DashboardDraft } from '@ink-stack/shared';
import type { InkDatabase } from '../storage/database.js';
import { readCodexLimits, type CodexLimitsResult } from '../connectors/codex-app-server.js';

export interface Connection { id:string; type:'codex-local'; name:string; revision:number; settings:Record<string,never>; configured:true }
export class Connections {
  private cached?: CodexLimitsResult;
  private cacheAt = 0;
  private pending?: Promise<CodexLimitsResult>;
  private lastGood?:CodexLimitsResult;
  constructor(private db: InkDatabase, private reader: ()=>Promise<CodexLimitsResult> = ()=>readCodexLimits()) {
    db.prepare('INSERT OR IGNORE INTO connections VALUES (?,?,?)').run('local-codex-app-server','codex-local','本机 Codex');
    db.prepare('INSERT OR IGNORE INTO connection_versions VALUES (?,?,?)').run('local-codex-app-server',1,'{}');
  }
  list(): Connection[] {
    return this.db.prepare('SELECT c.id,c.type,c.name,v.revision FROM connections c JOIN connection_versions v ON c.id=v.connection_id ORDER BY c.name,v.revision').all().map(row=>({...row as Omit<Connection,'settings'|'configured'>,settings:{},configured:true}));
  }
  create(name:string): Connection {
    const id = randomUUID();
    this.db.transaction(()=>{
      this.db.prepare('INSERT INTO connections VALUES (?,?,?)').run(id,'codex-local',name);
      this.db.prepare('INSERT INTO connection_versions VALUES (?,?,?)').run(id,1,'{}');
    })();
    return this.get(id,1)!;
  }
  version(id:string): Connection {
    const versions = this.list().filter(c=>c.id===id);
    if (!versions.length) throw new Error('connection_not_found');
    const revision = Math.max(...versions.map(c=>c.revision))+1;
    this.db.prepare('INSERT INTO connection_versions VALUES (?,?,?)').run(id,revision,'{}');
    return this.get(id,revision)!;
  }
  get(id:string,revision:number) { return this.list().find(c=>c.id===id && c.revision===revision); }
  validate(dashboard:DashboardDraft) {
    for (const widget of dashboard.widgets) {
      if(widget.type!=='codex-usage') continue;
      const {connectionId,connectionRevision}=widget.config;
      if(connectionId && !this.get(String(connectionId),Number(connectionRevision))) throw new Error('connection_reference_invalid');
    }
  }
  remove(id:string, dashboards:DashboardDraft[]) {
    if(dashboards.some(d=>d.widgets.some(w=>w.config.connectionId===id))) throw new Error('connection_in_use');
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM credentials WHERE connection_id=?').run(id);
      this.db.prepare('DELETE FROM connection_versions WHERE connection_id=?').run(id);
      this.db.prepare('DELETE FROM connections WHERE id=?').run(id);
    })();
    this.invalidate();
  }
  invalidate() { this.cached=undefined; this.lastGood=undefined; this.cacheAt=0; }
  previous(){return this.lastGood;}
  latest() { return this.cached ? {status:this.cached.status,observedAt:this.cached.observedAt,error:this.cached.error} : null; }
  groups(result=this.cached): {id:string;name:string}[] {
    const raw=result?.raw;
    if(raw?.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length) return Object.entries(raw.rateLimitsByLimitId).map(([id,b])=>({id,name:b.limitName??id}));
    return raw?.rateLimits ? [{id:raw.rateLimits.limitId || 'default',name:raw.rateLimits.limitName??'默认额度'}] : [];
  }
  async read(force=false): Promise<CodexLimitsResult> {
    if(this.pending) return this.pending;
    if(this.cached && Date.now()-this.cacheAt<(force?15_000:600_000)) return this.cached;
    this.pending=this.reader().then(result=>{
      if(result.status==='ok')this.lastGood=result;
      else if(['not_logged_in','unsupported_auth'].includes(result.status)||(result.identity&&this.lastGood?.identity!==result.identity))this.lastGood=undefined;
      // A failed read is never relabelled as a successful observation.
      this.cached=result;
      this.cacheAt=Date.now();
      return result;
    }).finally(()=>{this.pending=undefined;});
    return this.pending;
  }
}
