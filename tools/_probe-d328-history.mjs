// D328：010 的体积表到底是「读了另一份快照」还是「编的」？
// ★ 判据：如果它读的是更早的某个 commit，那 defs.js = 73,632 B 应当在 git 历史里真实存在过。
//   若历史上从来没有过这个数 ⇒ 不是快照差异，是编的。
// ★ 同时核一条我刚判错的：part4 = 253,118 与「距 8 KiB 红线 253,952 仅余 834 B」——
//   253,952 - 253,118 = 834 ⇒ 010 这一条**是对的**，我上一轮说它「基于错表」是我错。
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const sh = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  return `${r.stdout ?? ""}`;
};

// 010 §2 声称的原始字节
const CLAIM = {
  "lib/defs.js": 73632,
  "lib/base.js": 25213,
  "lib/client.js": 25088,
  "lib/part1.js": 119652,
  "lib/part3.js": 173275,
  "lib/part5.js": 92002,
  "lib/part2.js": 198274,
  "lib/part4.js": 253118,
  "lib/part4.js_x": 253118,
  "index.js": 1683,
};

console.log("═══ A. 历史上这些文件**有没有**出现过 010 报的字节数？ ═══");
for (const [f, want] of Object.entries(CLAIM)) {
  if (f.endsWith("_x")) continue;
  // 列这个文件所有历史版本的 blob 大小
  const out = sh(["log", "--all", "--format=%H", "--", f]);
  const shas = out.split("\n").filter((x) => x.trim() !== "");
  let hit = null;
  const sizes = new Set();
  for (const sha of shas.slice(0, 200)) {
    const b = spawnSync("git", ["cat-file", "-s", `${sha}:${f}`], { encoding: "utf8" });
    if (b.status === 0) {
      const n = Number(String(b.stdout).trim());
      if (Number.isFinite(n)) {
        sizes.add(n);
        if (n === want && hit === null) hit = sha.slice(0, 8);
      }
    }
  }
  const range = sizes.size === 0 ? "(从未存在)" : `min=${Math.min(...sizes)} max=${Math.max(...sizes)} 共${sizes.size}种`;
  console.log(
    `${f.padEnd(20)} 010报 ${String(want).padStart(7)}　历史${shas.length}版 ${range}` +
      (hit !== null ? `　★★ 命中于 ${hit}` : "　✗ 历史上从未出现过")
  );
}

console.log("");
console.log("═══ B. 我那一条判错的自查 ═══");
const part4 = fs.statSync("lib/part4.js").size;
const REDLINE = 262144 - 8192; // 253,952
console.log(`part4 实测 = ${part4} B`);
console.log(`8 KiB 红线 = ${REDLINE} B`);
console.log(`距红线 = ${REDLINE - part4} B　⇒ 010 说「仅剩 834 B」：${REDLINE - part4 === 834 ? "★★ 它是对的，我上一轮判错了" : "不符"}`);
console.log(`距 256 KiB 硬上限 = ${262144 - part4} B（这是我上一轮报的 9,026，口径不同）`);
console.log("PROBE-COMPLETE");
