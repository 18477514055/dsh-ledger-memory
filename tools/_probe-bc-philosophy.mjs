/**
 * ★★★ 只读探针 ③：**模型真正读到的那段话**全文。
 *
 * ★ 用户的问题："billion 就可以让模型经常调用工具，我们怎么不行"
 *   ⇒ 必须把它的 `COMPRESS_PHILOSOPHY` + `HOW_TO_COMPRESS_RULES`（**两者都进系统提示**）
 *     与 nudge 拼出来的正文**逐字**摆出来，然后跟我们的注入文案并列比较。
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

const dumpFile = (key, title, max) => {
  const lines = idx.get(key);
  console.log("\n" + "═".repeat(94));
  console.log(`【${title}】${key}（${lines === undefined ? "缺" : lines.length + " 行"}）`);
  console.log("═".repeat(94));
  if (lines === undefined) return;
  for (let k = 0; k < Math.min(max ?? lines.length, lines.length); k += 1) console.log(`${String(k + 1).padStart(4)} │ ${lines[k]}`);
};

dumpFile("../node_modules/acp-kernel/src/compression-rules.ts", "★ 模型读到的压缩哲学与规则（全 129 行）", 129);

// nudge 正文：找 renderNudgeText 的拼接（可能要往后再读）
const nt = idx.get("../node_modules/acp-kernel/src/nudge-text.ts");
if (nt !== undefined) {
  console.log("\n" + "═".repeat(94));
  console.log("【nudge 正文拼接（找出含 usage / target blocks 的那段）】");
  console.log("═".repeat(94));
  nt.forEach((t, i) => {
    if (/usage|Target |breakdown|compressible|nudge|⚠|💡/.test(t) && t.length > 18) {
      console.log(`${String(i + 1).padStart(4)} │ ${t.slice(0, 200)}`);
    }
  });
}
