import { readFileSync, readdirSync } from 'node:fs';
function walk(path) { return readdirSync(path,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(`${path}/${e.name}`):[`${path}/${e.name}`]); }
for (const file of walk('apps/web/src')) {
 const text=readFileSync(file,'utf8');
 if (/registry\.server|connectors\/|node:|better-sqlite3|resvg/.test(text)) throw Error(`Server import in browser: ${file}`);
}
console.log('Browser/server import boundaries passed. Strict typecheck is the static-analysis gate.');
