import fs from "node:fs";
const lines=fs.readFileSync("lib/client.js","utf8").split("\n");
for(let i=307;i<960;i++){
  if(/font-size:\s*[0-9.]+px/.test(lines[i])) console.log(`${i+1}: ${lines[i].trim()}`);
}
