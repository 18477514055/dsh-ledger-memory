import fs from "node:fs";
const src=fs.readFileSync("lib/defs.js","utf8").split("\n");
const keys=["highFidelityCompactRatio","autoCompact","midTurnCompact","maxActiveLines","blockInjection","fileAnchor","maxReadChars","capsuleMaxChars"];
for(const k of keys){
  const i=src.findIndex(l=>l.includes(`key: "${k}"`));
  if(i<0){ console.log(k+" 未找到"); continue; }
  console.log(`\n===== ${k} (line ${i+1}) =====`);
  for(let j=i;j<Math.min(i+22,src.length);j++){
    console.log(`  ${j+1}: ${src[j]}`);
    if(src[j].includes("},") && j>i+3) break;
  }
}
