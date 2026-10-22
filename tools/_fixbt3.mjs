import fs from "node:fs";
const P="lib/client.js";
const lines=fs.readFileSync(P,"utf8").split("\n");
// 动态定位 CSS 模板区间：从 「const CSS = `」 到下次以 ` 开头并以 ; 结尾的行
let s=-1,e=-1;
for(let i=0;i<lines.length;i++){
  if(lines[i].includes("const CSS = `")){ s=i; break; }
}
if(s>=0){ for(let i=s+1;i<lines.length;i++){ if(/^\s*`;?\s*$/.test(lines[i])){ e=i; break; } } }
console.log(`CSS 区间: ${s+1} .. ${e+1}`);
let n=0;
for(let i=s+1;i<e;i++){
  if(!lines[i].includes("`")) continue;
  let out="",open=true;
  for(const ch of lines[i]){ if(ch==="`"){ out += open?"「":"」"; open=!open; } else out+=ch; }
  lines[i]=out; n++;
}
fs.writeFileSync(P,lines.join("\n"),"utf8");
console.log("修正行数:",n);
