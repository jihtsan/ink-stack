import { parentPort } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { ditherRect } from './dither.js';
import { computePixelRect, type DashboardDraft, type WidgetDataEnvelope } from '@ink-stack/shared';
import { renderWidgetToSvg } from '@ink-stack/widgets/registry.server';

export interface RenderInput { dashboard: DashboardDraft; data:Record<string,WidgetDataEnvelope>; now:string; fontPath:string }
parentPort!.on('message', async (input:RenderInput)=>{
  try {
    const {dashboard:d,data,now,fontPath}=input;
    const parts=d.widgets.map((widget,index)=>{
      const rect=computePixelRect(d.screen,d.grid,widget);
      const body=renderWidgetToSvg(widget,{now,timeZone:d.timeZone,rect,screen:d.screen},data[widget.id]);
      return `<defs><clipPath id="c${index}"><rect width="${rect.width}" height="${rect.height}"/></clipPath></defs><g transform="translate(${rect.x},${rect.y})"><g clip-path="url(#c${index})">${body}</g></g>`;
    });
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${d.screen.width}" height="${d.screen.height}" viewBox="0 0 ${d.screen.width} ${d.screen.height}"><rect width="100%" height="100%" fill="${d.theme.background}"/>${parts.join('')}</svg>`;
    const raster=new Resvg(svg,{font:{fontFiles:[fontPath],loadSystemFonts:false,defaultFontFamily:'Noto Sans CJK SC'}}).render().asPng();
    const pixels=await sharp(raster).flatten({background:'#ffffff'}).removeAlpha().greyscale().raw().toBuffer();
    for (const widget of d.widgets) {
      if (widget.type === 'weather' && widget.config.dither === true) ditherRect(pixels,d.screen.width,computePixelRect(d.screen,d.grid,widget));
    }
    const png=await sharp(pixels,{raw:{width:d.screen.width,height:d.screen.height,channels:1}}).toColourspace('b-w').png({palette:false}).toBuffer();
    const meta=await sharp(png).metadata();
    if(meta.width!==d.screen.width || meta.height!==d.screen.height || meta.channels!==1 || meta.hasAlpha || meta.format!=='png') throw new Error('invalid_png');
    parentPort!.postMessage({png});
  } catch { parentPort!.postMessage({error:'render_failed'}); }
});

