import fs from "node:fs";
const src=fs.readFileSync("lib/client.js","utf8").split("\n");
for(let i=0;i<src.length;i++){
  if(/pl-settings__ctl-wrap--num|pl-settings__row:not|--pl-num-w|pl-settings__ctl \{/.test(src[i])) console.log(`${i+1}: ${src[i].trim().slice(0,150)}`);
}
