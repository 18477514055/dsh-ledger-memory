import fs from "node:fs";
const P="lib/client.js";
const lines=fs.readFileSync(P,"utf8").split("\n");
// CSS 模板内部（308..909 之间）：把注释里的成对反引号换成 「」；先全换「再修成对
let n=0;
for(let i=307;i<909;i++){
  if(!lines[i].includes("`")) continue;
  if(lines[i].includes("const CSS = `")) continue;
  if(/^\s*`;?\s*$/.test(lines[i])) continue;
  let s=lines[i], out="", open=true;
  for(const ch of s){ if(ch==="`"){ out += open ? "「" : "」"; open=!open; } else out+=ch; }
  lines[i]=out; n++;
}
fs.writeFileSync(P,lines.join("\n"),"utf8");
console.log("修正行数:",n);
