/**
 * 只读自检：确认文件没被"读取→替换→写回"弄坏。
 *   · U+FFFD（替换字符）必须为 0
 *   · 反引号奇偶必须平衡
 *   · 中文是否还能正常解码（抽几个已知词）
 */
import fs from "node:fs";

for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f);
  const s = buf.toString("utf8");
  const fffd = (s.match(/\uFFFD/g) ?? []).length;
  const B = String.fromCharCode(96);
  let odd = 0;
  for (const L of s.split("\n")) {
    let n = 0;
    for (const c of L) if (c === B) n++;
    if (n % 2 === 1) odd++;
  }
  const probes = ["水位", "压缩", "事件名", "只读探针", "全量"];
  const hits = probes.filter((p) => s.includes(p));
  console.log(`${f}`);
  console.log(`  字节=${buf.length}  U+FFFD=${fffd}  奇数反引号行=${odd}`);
  console.log(`  中文抽样命中 ${hits.length}/${probes.length}: ${hits.join(" ")}`);
}
