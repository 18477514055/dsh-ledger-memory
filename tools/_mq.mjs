import fs from "node:fs";
const src=fs.readFileSync("lib/client.js","utf8");
const i=src.indexOf(".pl-settings__main");
console.log("=== .pl-settings__main 定义 ===");
console.log(src.slice(i-200,i+400));
console.log("\n=== 所有 @media 块 ===");
const re=/@media[^{]*\{[\s\S]*?\n\}/g; let m;
while((m=re.exec(src))!==null){
  if(m[0].includes("pl-settings")) { console.log("\n-----"); console.log(m[0]); }
}
