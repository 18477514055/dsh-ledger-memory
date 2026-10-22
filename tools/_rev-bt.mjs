import fs from "node:fs";
const src = fs.readFileSync("lib/client.js","utf8");
function check(s){
  const m = /const CSS = `([\s\S]*?)`;\n/.exec(s);
  if(m===null) return {found:false};
  const body=m[1];
  const bad=body.split("\n").filter(l=>l.includes("`"));
  return {found:true, len:body.length, badLines:bad.length, ok: bad.length===0 && body.length>8000};
}
const real = check(src);
console.log("真源码  :", JSON.stringify({len:real.len, badLines:real.badLines, ok:real.ok}));
// 注入一个反引号到 CSS 注释里（模拟我今天犯的错）
const mutated = src.replace("/* ── 开关（滑块式）", "/* ── 开关（滑块式） `input`");
const mut = check(mutated);
console.log("注入反引号:", JSON.stringify({len:mut.len, badLines:mut.badLines, ok:mut.ok}));
console.log(mut.ok===false ? "✓ 反向验证通过：注入反引号后断言变红" : "✗ 断言没有区分力！");
