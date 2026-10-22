const m = await import("../lib/defs.js");
for(const s of m.SETTING_SPECS){
  console.log(`${(s.group||"?").padEnd(9)} ${s.key.padEnd(28)} ${String(s.kind).padEnd(8)} ${s.label}`);
}
console.log("总数:", m.SETTING_SPECS.length);
