// 落盘：把 _tmp3-final.md 覆盖到 LEDGER.md，并把 _tmp3-entries.md 追加到归档。
import fs from "node:fs";
const final = fs.readFileSync("_tmp3-final.md", "utf8");
const entries = fs.readFileSync("_tmp3-entries.md", "utf8");
const lines = final.split("\n");
console.log("final lines", lines.length, "entries lines", entries.split("\n").length);
// 只打印，不写：落盘交给 ledger_archive / ledger_write 工具（保证 revision 与登记正确）
console.log("first", lines[0]);
console.log("hasChangeRegister", lines.some((l) => l.startsWith("## 变更登记")));
console.log("hasNewEntry", lines.some((l) => l.startsWith("- [7c1f] 14:1x")));
