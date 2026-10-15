// D216 修补 · 把"正文不一致"那 5 条**逐字打出来**，确认它们是我**有意**的文案改动，
// 不是拆分造成的损坏。（★ 纪律 7：结论与自己已手工验证过的事实冲突时，先怀疑尺子。）
import fs from "node:fs";
import path from "node:path";

const PRE = "D:\\Deepseek工作区\\20-DSH插件\\_插件备份\\10.项目台账\\2026-10-15-181611-拆分实施前";
const REPO = process.cwd();

function declsOf(text) {
  const lines = text.split("\n");
  const re = /^(export\s+)?(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (m !== null) starts.push({ line: i + 1, name: m[4] });
  }
  const out = new Map();
  for (let k = 0; k < starts.length; k += 1) {
    const s = starts[k];
    const next = k + 1 < starts.length ? starts[k + 1].line : lines.length + 1;
    let end = next - 1;
    while (end > s.line && lines[end - 1].trim() === "") end -= 1;
    out.set(s.name, lines.slice(s.line - 1, end).join("\n").replace(/^export\s+/, ""));
  }
  return out;
}

const orig = declsOf(fs.readFileSync(path.join(PRE, "lib", "index.js"), "utf8"));
const libDir = path.join(REPO, "lib");
const now = new Map();
for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith(".js") && n !== "client.js")) {
  for (const [k, v] of declsOf(fs.readFileSync(path.join(libDir, f), "utf8"))) {
    if (!now.has(k)) now.set(k, { text: v, file: f });
  }
}

const norm = (x) => x.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const names = ["LOCK_STORE_FILE", "officialSessionPath", "renderPressureNotice", "renderInjectionBody", "LEDGER_SUBCOMMANDS"];

for (const nm of names) {
  const a = norm(orig.get(nm) ?? "");
  const b = norm(now.get(nm)?.text ?? "");
  console.log("═".repeat(70));
  console.log(`${nm}  —— 现在在 ${now.get(nm)?.file}`);
  if (a === b) { console.log("  （相同 —— 不该出现在这里）"); continue; }
  const A = a.split("\n"), B = b.split("\n");
  // 逐行比：只打印不同的行
  const max = Math.max(A.length, B.length);
  for (let i = 0; i < max; i++) {
    if (A[i] !== B[i]) {
      console.log(`  L${i + 1}`);
      console.log(`    旧: ${JSON.stringify(A[i] ?? null)}`);
      console.log(`    新: ${JSON.stringify(B[i] ?? null)}`);
    }
  }
}
