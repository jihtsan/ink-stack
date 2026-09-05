import { Worker } from 'node:worker_threads';
import type { RenderInput } from '../workers/render.worker.js';

export class Renderer {
  private worker?: Worker;
  private recycling?: Promise<void>;
  private busy=false;
  constructor(private timeoutMs=20_000, private workerUrl=new URL('../workers/render.worker.js',import.meta.url)) {}
  async render(input:RenderInput):Promise<Buffer> {
    if(this.busy) throw new Error('renderer_busy');
    this.busy=true;
    try {
      await this.recycling;
      if(!this.worker){
        const created=new Worker(this.workerUrl);
        const clear=()=>{if(this.worker===created)this.worker=undefined;};
        // Keep idle worker failures from becoming an unhandled main-process error.
        created.on('error',clear);created.on('exit',clear);
        this.worker=created;
      }
      const worker=this.worker;
      return await new Promise<Buffer>((resolve,reject)=>{
        const timer=setTimeout(()=>{cleanup();this.recycle(worker);reject(new Error('render_timeout'));},this.timeoutMs);
        const cleanup=()=>{clearTimeout(timer);worker.off('message',onMessage);worker.off('error',onError);worker.off('exit',onExit);};
        const onMessage=(message:{png?:Uint8Array;error?:string})=>{cleanup();message.png?resolve(Buffer.from(message.png)):reject(new Error('render_failed'));};
        const onError=()=>{cleanup();this.recycle(worker);reject(new Error('render_failed'));};
        const onExit=()=>{cleanup();if(this.worker===worker)this.worker=undefined;reject(new Error('renderer_exited'));};
        worker.once('message',onMessage);worker.once('error',onError);worker.once('exit',onExit);
        try { worker.postMessage(input); } catch { cleanup();this.recycle(worker);reject(new Error('render_failed')); }
      });
    } finally {this.busy=false;}
  }
  async close(){await this.recycling;const worker=this.worker;this.worker=undefined;if(worker)await worker.terminate();}
  private recycle(worker:Worker){
    if(this.worker===worker)this.worker=undefined;
    this.recycling=worker.terminate().then(()=>undefined,()=>undefined).finally(()=>{if(this.recycling)this.recycling=undefined;});
  }
}
