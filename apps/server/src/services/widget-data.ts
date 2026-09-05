import type {DashboardDraft,WidgetDataEnvelope} from '@ink-stack/shared';
import { normalizeCodexUsageSnapshot, type RawCodexRateLimitsResponse } from '@ink-stack/widgets/codex-usage/normalize';
import type {Connections} from '../data/connections.js';

export async function collectWidgetData(dashboard:DashboardDraft,connections:Connections):Promise<Record<string,WidgetDataEnvelope>>{
  const widgets=dashboard.widgets.filter(w=>w.type==='codex-usage');
  if(!widgets.length)return {};
  const result=await connections.read();
  const data:Record<string,WidgetDataEnvelope>={};
  const now=new Date().toISOString();
  for(const widget of widgets){
    let source=result;
    const previous=connections.previous();
    const stale=result.status!=='ok'&&previous&&result.identity!==undefined&&result.identity===previous.identity&&!['not_logged_in','unsupported_auth'].includes(result.status);
    if(stale)source=previous;
    const state=result.status==='not_logged_in'?'unauthenticated':result.status==='unsupported_auth'?'unsupported':'unavailable';
    if(source.status!=='ok'||!source.raw){data[widget.id]={status:state,observedAt:source.observedAt,message:state==='unauthenticated'?'需要在服务主机登录 Codex':state==='unsupported'?'此登录方式不支持 Codex 额度':'Codex 额度暂不可用'};continue;}
    const snapshot=normalizeCodexUsageSnapshot(source.raw as RawCodexRateLimitsResponse,{selectedQuotaGroupId:String(widget.config.quotaGroupId),observedAt:source.observedAt,now,maxStaleMs:3600_000});
    if((stale||Date.parse(now)-Date.parse(source.observedAt)>900_000)&&snapshot.state!=='missing'){
      snapshot.state='stale';snapshot.message='读取失败或数据过期，显示上次采集值';
    }
    const expired=Date.parse(now)-Date.parse(source.observedAt)>3600_000;
    if(expired){data[widget.id]={status:'unavailable',observedAt:source.observedAt,message:'额度超过一小时未更新'};continue;}
    const status=snapshot.state==='missing'||snapshot.state==='error'?'unavailable':snapshot.state;
    data[widget.id]={status,observedAt:source.observedAt,data:snapshot};
  }
  return data;
}
