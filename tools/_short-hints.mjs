import fs from "node:fs";
const P="lib/defs.js";
let src=fs.readFileSync(P,"utf8");
const NEW={
  highFidelityCompactRatio:"水位到本值就在回合末压一次。调小＝压得更早、更省。",
  settingPrecedence:"面板值与项目清单冲突时，以谁为准。",
  autoCompact:"关掉后插件不再自行压缩。",
  midTurnCompact:"长回合中途就在回合内压，不用等回合结束。",
  maxActiveLines:"台账超过这个行数就截断注入，并要求先归档。",
  turnEndOffer:"每回合结束问一次：记台账 / 压缩 / 写交接单。",
  blockInjection:"没读过的区块只给标题与位置；压缩后一定补回正文。",
  fileAnchor:"每回合推一段小索引：先读哪份、还有哪些没读。",
  maxReadChars:"台账超过这个长度就截断注入。",
  capsuleMaxChars:"压缩后注回的逐字素材最多带多少字符。",
};
let done=0, fail=[];
for(const [key,txt] of Object.entries(NEW)){
  const ki=src.indexOf(`key: "${key}"`);
  if(ki<0){ fail.push(key+" 找不到 key"); continue; }
  const hi=src.indexOf("hint:", ki);
  if(hi<0){ fail.push(key+" 找不到 hint"); continue; }
  const q=src.indexOf('"', hi);
  // 找配对引号（处理反斜杠转义）
  let j=q+1;
  while(j<src.length){
    if(src[j]==="\\"){ j+=2; continue; }
    if(src[j]==='"') break;
    j++;
  }
  const old=src.slice(q+1,j);
  src=src.slice(0,q+1)+txt+src.slice(j);
  console.log(`${key}: ${old.length} → ${txt.length} 字`);
  done++;
}
fs.writeFileSync(P,src,"utf8");
console.log(`\n已改 ${done} 条，失败 ${fail.length}：${fail.join(" | ")}`);
