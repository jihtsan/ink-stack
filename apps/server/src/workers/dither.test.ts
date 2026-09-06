import { expect, it } from 'vitest';
import { ditherRect } from './dither.js';

it('quantizes only the selected widget to 16 gray levels and is deterministic',()=>{
  const source=Uint8Array.from({length:100},(_,i)=>(i*31)%256);
  const output=source.slice();const repeat=source.slice();const rect={x:2,y:2,width:5,height:6};
  ditherRect(output,10,rect);ditherRect(repeat,10,rect);
  expect(output).toEqual(repeat);
  for(let y=0;y<10;y++)for(let x=0;x<10;x++){
    if(x>=2&&x<7&&y>=2&&y<8)expect(output[y*10+x]!%17).toBe(0);
    else expect(output[y*10+x]).toBe(source[y*10+x]);
  }
});

it('keeps solid black and white exact at rectangle edges',()=>{
  for(const color of [0,255]){const pixels=new Uint8Array(4).fill(color);ditherRect(pixels,2,{x:0,y:0,width:2,height:2});expect([...pixels]).toEqual([color,color,color,color]);}
});
