import fs from "node:fs";
const src=fs.readFileSync("lib/defs.js","utf8").split("\n");
for(const k of ["maxReadChars","capsuleMaxChars","settingPrecedence"]){
  const i=src.findIndex(l=>l.includes(`key: "${k}"`));
  console.log(`\n===== ${k} (${i+1}) =====`);
  for(let j=i;j<i+14 && j<src.length;j++) console.log(`  ${j+1}: ${src[j]}`);
}
