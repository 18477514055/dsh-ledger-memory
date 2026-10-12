/**
 * ★★★ 只读探针 ④：billion-context 的 **nudge 抑制门** —— 它怎么避免"每步都推"毁掉缓存。
 *
 * ★ 为什么这条对它能否照搬是决定性的：
 *   记忆库记着它的实测「约 96% 的 nudge（1212/1266）**因可压缩量或增量不足而自我压制**，
 *   仅 54 次真正注入」。⇒ ★ **推得准**的关键**不是**"判据多聪明"，而是
 *   **绝大多数时候根本不推**（否则每步一段新文本 ⇒ prompt 缓存每步全冷）。
 *   ⇒ 我们必须知道它靠哪几道门压住，才能设计我们自己的。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const B = path.join(os.homedir(), ".dsh", "profiles", "desktop", "node_modules", "billion-context.bak-0.1.179");
const map = JSON.parse(fs.readFileSync(path.join(B, "dist", "index.js.map"), "utf8"));
const idx = new Map();
for (let i = 0; i < map.sources.length; i += 1) {
  if (typeof map.sourcesContent[i] === "string") idx.set(map.sources[i], map.sourcesContent[i].split("\n"));
}
const cz = idx.get("../node_modules/acp-kernel/src/compress.ts");
if (cz === undefined) {
  console.log("compress.ts 不在 map 里");
  process.exit(0);
}

console.log("=== nudge 决定的完整段落（1700–1760，含 re-arm 与抑制理由）===");
for (let k = 1699; k < 1760 && k < cz.length; k += 1) console.log(`${String(k + 1).padStart(5)} │ ${cz[k]}`);

console.log("\n=== 抑制原因（为什么这次不推）—— 搜 reason/label 里的说明 ===");
cz.forEach((t, i) => {
  if (/min benefit|self-suppress|suppressed|no re-arm|unreachable|below|not worth/i.test(t) && t.length < 220) {
    console.log(`${String(i + 1).padStart(5)} │ ${t.trim()}`);
  }
});
