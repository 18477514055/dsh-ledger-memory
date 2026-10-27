// D328：用**真模板**（从 part8.js:495-501 逐字抄）验 F-03。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const part8 = await import(pathToFileURL(path.join(ROOT, "lib", "part8.js")).href);
const mode = { storage: "file", file: "NOTES.md", label: "决策型", hint: "按决策卡那套规则管。" };

/** 逐字复刻 createExtension 写的模板（part8.js:496-500）。 */
const tpl = (name, desc) => `# ${name}\n\n${desc}\n\n> **自定义扩展记忆**（模式：${mode.label}）。${mode.hint}\n\n---\n\n`;

const cases = [
  ["只有模板", tpl("Boss机制记录", "记 Boss 机制")],
  ["模板 + 1 行真内容", tpl("Boss机制记录", "记 Boss 机制") + "- 一阶段会飞天\n"],
  ["模板 + 2 行真内容", tpl("Boss机制记录", "记 Boss 机制") + "- 一阶段会飞天\n- 二阶段召唤小怪\n"],
  ["模板 + 3 行真内容", tpl("Boss机制记录", "记 Boss 机制") + "- A\n- B\n- C\n"],
];

let fail = 0;
console.log("═══ 现行判据（非空行 ≤ 6 算空）对真模板的判定 ═══");
for (const [name, body] of cases) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "d328f03-"));
  fs.writeFileSync(path.join(d, "NOTES.md"), body, "utf8");
  const nonEmpty = body.split("\n").filter((l) => l.trim() !== "").length;
  const u = part8.extUsageOf(d, mode);
  const shouldBeEmpty = name === "只有模板";
  const wrong = u.hasContent === shouldBeEmpty; // 判反了 = bug
  if (wrong) fail += 1;
  console.log(
    `${name.padEnd(18)} 非空行=${String(nonEmpty).padStart(2)}  hasContent=${String(u.hasContent).padEnd(5)}` +
      `  期望 hasContent=${!shouldBeEmpty}` +
      (wrong ? "  ⚠ **判反了**" : "  ✓")
  );
  fs.rmSync(d, { recursive: true, force: true });
}
console.log("");
console.log(fail > 0 ? `⇒ ★ **F-03 属实**：${fail} 个含真实内容的用例被判成「只有模板」⇒ 免确认可删` : "⇒ F-03 不成立");
console.log("");
console.log("★ 根因：模板本身就有 **4 个非空行**（标题/描述/标记行/分隔线），");
console.log("  而判据是「非空行 ≤ 6」⇒ 用户再写 **1~2 行**真内容仍落在阈值内 ⇒ 被当成模板。");
console.log("  正确判据：**`\\n---\\n` 之后是否还有非空内容**（分隔线就是模板与用户内容的分界）。");
console.log("PROBE-COMPLETE");
