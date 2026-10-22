import fs from "node:fs";
const P="lib/client.js";
const lines=fs.readFileSync(P,"utf8").split("\n");
// 只动 CSS 模板内部
let s=-1,e=-1;
for(let i=0;i<lines.length;i++){ if(lines[i].includes("const CSS = `")){ s=i; break; } }
for(let i=s+1;i<lines.length;i++){ if(/^\s*`;?\s*$/.test(lines[i])){ e=i; break; } }
let nf=0, nl=0;
const rnd=(x)=>Number.isInteger(x)? String(x) : x.toFixed(1).replace(/\.0$/,"");
for(let i=s+1;i<e;i++){
  const before=lines[i];
  lines[i]=lines[i].replace(/font-size:\s*([0-9.]+)px/g,(m,v)=>{ nf++; return `font-size: ${rnd(parseFloat(v)+1.5)}px`; });
  lines[i]=lines[i].replace(/line-height:\s*([0-9.]+)px/g,(m,v)=>{ nl++; return `line-height: ${rnd(parseFloat(v)+2)}px`; });
  if(before!==lines[i]) console.log(`  ${before.trim().slice(0,60)}  →  ${lines[i].trim().slice(0,60)}`);
}
fs.writeFileSync(P,lines.join("\n"),"utf8");
console.log(`\n字号改动 ${nf} 处，行高改动 ${nl} 处`);
