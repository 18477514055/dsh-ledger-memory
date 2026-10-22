const m = await import("../lib/defs.js");
const keys=["highFidelityCompactRatio","mode","autoCompact","midTurnCompact","maxActiveLines","turnEndOffer","blockInjection","fileAnchor","maxReadChars","capsuleMaxChars"];
for(const k of keys){
  const s=m.SETTING_SPECS.find(x=>x.key===k);
  if(!s) { console.log(k+" 不存在"); continue; }
  console.log(`── ${k}（${String(s.hint||"").length} 字）`);
  console.log("   "+(s.hint||"").replace(/\n/g," "));
}
