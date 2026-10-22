# V3 阶段 0.1：绕过 inspect() 的硬编码路径拼接

> 生成：node tools/_probe-v3-hardcoded-paths.mjs
> 可疑 104 处 · inspect() 内部 19 处（不计）

## 判据
一个 `path.join/resolve` **不算问题**的条件：参数里出现 `info` / `.Rel` / `.Abs` / `memoryRoot` / `projectRoot`，
或者它位于 `inspect()` 函数体内部。其余算可疑。

## 可疑清单

- `lib/part1.js:425` — return typeof home === "string" && home !== "" ? home : path.join(os.homedir(), ".dsh");
- `lib/part1.js:438` — return path.join(dshHome(), LOCK_STORE_DIRNAME, LOCK_STORE_PKG, LOCK_STORE_FILE);
- `lib/part1.js:518` — return path.join(path.dirname(lockStorePath()), ANCHOR_STORE_FILE);
- `lib/part1.js:635` — const pkgPath = path.join(here, "..", "package.json");
- `lib/part1.js:651` — return path.join(path.dirname(lockStorePath()), CAPABILITY_STORE_FILE);
- `lib/part1.js:1057` — return path.join(path.dirname(lockStorePath()), OWED_STORE_FILE);
- `lib/part1.js:1198` — return path.join(path.dirname(lockStorePath()), BLOCK_HISTORY_FILE);
- `lib/part1.js:1330` — return path.join(path.dirname(lockStorePath()), CAPSULE_STORE_FILE);
- `lib/part1.js:1538` — return path.join(path.dirname(lockStorePath()), SHADOWED_INDEX_FILE);
- `lib/part1.js:1612` — const dir = path.join(dshHome(), "sessions", encodeSessionDirName(path.resolve(cwd)));
- `lib/part1.js:1614` — const file = path.join(dir, name, "session.v4.jsonl.zstd");
- `lib/part1.js:2659` — const abs = path.resolve(String(root));
- `lib/part1.js:2679` — cwd: typeof cwd === "string" ? path.resolve(cwd) : undefined,
- `lib/part1.js:3536` — const w = writeFileAtomic(path.join(root, MANIFEST_REL), JSON.stringify(next, null, 2) + "\n");
- `lib/part1.js:3561` — const abs = path.join(root, MANIFEST_REL);
- `lib/part1.js:4167` — const absDir = path.resolve(memBase, relDir);
- `lib/part1.js:4187` — const abs = path.resolve(memBase, rel);
- `lib/part1.js:4208` — fs.writeFileSync(path.resolve(memBase, rel2), body, { encoding: "utf8", flag: "wx" });
- `lib/part1.js:4257` — const absDir = path.resolve(memBaseS, relDir);
- `lib/part1.js:4262` — const abs = path.resolve(memBaseS, rel);
- `lib/part1.js:4309` — fs.writeFileSync(path.resolve(memBaseS, rel2), body, { encoding: "utf8", flag: "wx" });
- `lib/part2.js:58` — const abs = path.resolve(memBase, relPath);
- `lib/part2.js:792` — const abs = lcard ? undefined : path.resolve(memBaseL, rel);
- `lib/part2.js:1247` — const abs = path.resolve(memBaseG, relPath);
- `lib/part2.js:1436` — const abs = path.resolve(root, targetRel);
- `lib/part2.js:1545` — const abs = path.resolve(root, MANIFEST_REL);
- `lib/part2.js:1561` — const abs = path.resolve(root, MANIFEST_REL);
- `lib/part2.js:1668` — let dir = path.resolve(start);
- `lib/part2.js:1673` — if (fs.existsSync(path.join(dir, ".git"))) return dir;
- `lib/part2.js:1810` — const dirAbs = path.resolve(mBase, cmode.dirRel);
- `lib/part2.js:2036` — const r = path.resolve(root);
- `lib/part2.js:2037` — const t = path.resolve(target);
- `lib/part2.js:2089` — const tail = path.relative(path.resolve(anchor), path.resolve(target));
- `lib/part2.js:2090` — const targetReal = tail === "" ? anchorReal : path.join(anchorReal, tail);
- `lib/part2.js:2108` — return fs.realpathSync.native(path.resolve(p));
- `lib/part2.js:2111` — return fs.realpathSync(path.resolve(p));
- `lib/part2.js:2121` — let cur = path.resolve(target);
- `lib/part2.js:2167` — const abs = path.resolve(file);
- `lib/part2.js:2876` — return fs.statSync(path.resolve(root, rel)).size;
- `lib/part2.js:2987` — const file = path.join(root, ...relFile.split("/"));
- `lib/part2.js:3565` — `- 历次逐字胶囊（**原件**）：\`${path.join(memBase, capDirRel)}\`` +
- `lib/part2.js:3806` — const here = typeof cwd === "string" && cwd !== "" ? path.resolve(cwd) : undefined;
- `lib/part2.js:4349` — const child = path.join(dir, e.name);
- `lib/part2.js:4351` — if (fs.existsSync(path.join(child, ".git"))) {
- `lib/part2.js:4770` — const hookFile = path.join(hooksDir, "pre-commit");
- `lib/part3.js:1475` — const abs = path.resolve(b.root, fileRel);
- `lib/part3.js:1668` — const abs = path.resolve(base ?? process.cwd(), raw);
- `lib/part3.js:3096` — const outFile = path.join(rootDir, MIDTURN_DIAG_FILE);
- `lib/part4.js:33` — const manifestPath = path.join(root, MANIFEST_REL);
- `lib/part4.js:124` — const abs = path.resolve(mBaseRc, dirRel);
- `lib/part4.js:273` — const abs = path.resolve(root, c.rel);
- `lib/part4.js:763` — const abs = path.resolve(memRootAbs, value);
- `lib/part4.js:778` — const abs = path.resolve(memRootAbs, value);
- `lib/part4.js:801` — const abs = path.resolve(memRootAbs, rel.trim());
- `lib/part4.js:870` — const norm = (rel) => (typeof rel === "string" && rel !== "" ? path.resolve(memRootAbs, rel).toLowerCase() : undefined);
- `lib/part4.js:910` — const archAbs = path.resolve(memRootAbs, archiveDir);
- `lib/part4.js:919` — const decisionsAbs = path.resolve(memRootAbs, decisions);
- `lib/part4.js:920` — const archiveAbs = path.resolve(memRootAbs, archiveDir);
- `lib/part4.js:956` — const jAbs = path.resolve(memRootAbs, journal);
- `lib/part4.js:979` — const abs = path.resolve(memRootAbs, value);
- `lib/part4.js:1044` — if (!fs.existsSync(path.join(root, ".git"))) {
- `lib/part4.js:1050` — } else if (fs.existsSync(path.join(root, ".git"))) {
- `lib/part4.js:1114` — if (journal !== "") ensureFile(path.resolve(memRootAbs, journal), journal, args?.initialJournal, "journal");
- `lib/part4.js:1115` — if (goals !== "") ensureFile(path.resolve(memRootAbs, goals), goals, args?.initialGoals, "goals");
- `lib/part4.js:1116` — if (lessons !== "") ensureFile(path.resolve(memRootAbs, lessons), lessons, args?.initialLessons, "lessons");
- `lib/part4.js:1120` — if (logDir !== "") ensureDir(path.resolve(memRootAbs, logDir));
- `lib/part4.js:1128` — if (decisionsDir !== "") ensureDir(path.resolve(memRootAbs, decisionsDir));
- `lib/part4.js:1129` — if (lessonsDir !== "") ensureDir(path.resolve(memRootAbs, lessonsDir));
- `lib/part4.js:1130` — if (goalsDir !== "") ensureDir(path.resolve(memRootAbs, goalsDir));
- `lib/part4.js:1159` — const pAbs = path.resolve(memRootAbs, principles);
- `lib/part4.js:1306` — const mw = writeFileAtomic(path.join(root, MANIFEST_REL), JSON.stringify(manifest, null, 2) + "\n");
- `lib/part4.js:1318` — if (manifest.autoGitAdd && fs.existsSync(path.join(root, ".git"))) {
- `lib/part4.js:1379` — manifestPath: path.join(root, MANIFEST_REL),
- `lib/part4.js:1537` — const file = path.resolve(mBase, rel);
- `lib/part4.js:1563` — const p = path.join(d, e.name);
- `lib/part4.js:1613` — const abs = cardWhole !== undefined ? cardDirAbs(mBaseR, cMode.dirRel) : path.resolve(mBaseR, relPath);
- `lib/part4.js:1888` — return path.resolve(root, dirRel);
- `lib/part4.js:1912` — const abs = path.resolve(cardDirAbs(root, dirRel), `${key.trim()}.md`);
- `lib/part4.js:1939` — chars = fs.readFileSync(path.join(dir, e.name), "utf8").length;
- `lib/part4.js:2107` — const abs = path.resolve(cardDirAbs(root, dirRel), "INDEX.md");
- `lib/part4.js:2175` — const abs = path.resolve(mBaseE, rel);
- `lib/part4.js:2240` — const abs = path.resolve(memBase, rel);
- `lib/part4.js:2322` — const srcAbs = path.resolve(mBaseS, rel);
- `lib/part4.js:2479` — const abs = path.resolve(root, MANIFEST_REL);
- `lib/part4.js:2963` — const abs = path.resolve(memBase, relPath);
- `lib/part4.js:3361` — const periodDir = path.join(archiveAbs, dir);
- `lib/part4.js:3364` — const archiveFile = path.join(periodDir, `${stem}-archive.md`);
- `lib/part4.js:3688` — const abs = path.resolve(memBase, fileRel);
- `lib/part4.js:3746` — const abs = path.join(dir, e.name);
- `lib/part4.js:4413` — const abs = path.resolve(base ?? process.cwd(), raw);
- `lib/part5.js:536` — const abs = path.resolve(memBase, fileRel);
- `lib/part5.js:1252` — `登记位置：\`${path.join(root, MANIFEST_REL)}\`\n\n` +
- `lib/part5.js:1298` — const abs = path.resolve(base ?? process.cwd(), want);
- `lib/part6.js:286` — const abs = isRoot ? path.resolve(root) : path.resolve(root, dirRel);
- `lib/part6.js:358` — const abs = path.resolve(base, rel);
- `lib/part7.js:112` — const abs = path.join(root, rel);
- `lib/part7.js:118` — const p = path.join(d, e.name);
- `lib/part7.js:130` — const to = path.join(destRoot, rel);
- `lib/part7.js:171` — fs.writeFileSync(path.join(partialAbs, victim.rel), "★ 被故意写坏的内容（探针注入）\n", "utf8");
- `lib/part7.js:179` — const p = path.join(partialAbs, e.rel);
- `lib/part7.js:237` — const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
- `lib/part7.js:238` — const retiredRoot = path.join(home, "plugin-data", "dsh-ledger-memory", "_retired", baseName);
- `lib/part7.js:239` — retiredTo = path.join(retiredRoot, stampSec(new Date()).replace(/[: ]/g, "-"));
- `lib/part7.js:244` — const to = path.join(retiredTo, rel);

## inspect() 内部（允许，仅供参考）

- `lib/part2.js:3933` — const cand = path.resolve(projectRoot, memoryRootRaw);
- `lib/part2.js:3946` — return fs.existsSync(path.join(projectRoot, ".git"));
- `lib/part2.js:3952` — const gitignorePath = path.join(projectRoot, ".gitignore");
- `lib/part2.js:3983` — const cand = path.resolve(projectRoot, DEFAULT_PRINCIPLES_NAME);
- `lib/part2.js:3999` — const cand = path.resolve(projectRoot, DEFAULT_GOALS_NAME);
- `lib/part2.js:4015` — const cand = path.resolve(projectRoot, DEFAULT_JOURNAL_NAME);
- `lib/part2.js:4031` — const cand = path.resolve(projectRoot, DEFAULT_LESSONS_NAME);
- `lib/part2.js:4071` — const r = isUnderReal(memoryBase, path.resolve(memoryBase, rel));
- `lib/part2.js:4101` — const candidate = path.resolve(memoryBase, logRel);
- `lib/part2.js:4155` — const cand = path.resolve(notesBase, declared);
- `lib/part2.js:4165` — if (fs.statSync(path.join(notesBase, c)).isDirectory()) {
- `lib/part2.js:4167` — notesAbs = path.join(notesBase, c);
- `lib/part2.js:4179` — notesAbs = path.resolve(notesBase, DEFAULT_NOTES_DIR);
- `lib/part2.js:4186` — const candidate = path.resolve(memoryBase, activeRel);
- `lib/part2.js:4219` — const cand = path.resolve(memoryBase, manifestHandoff);
- `lib/part2.js:4228` — if (fs.statSync(path.resolve(memoryBase, c)).isDirectory()) {
- `lib/part2.js:4230` — handoffAbs = path.resolve(memoryBase, c);
- `lib/part2.js:4240` — handoffAbs = path.resolve(memoryBase, DEFAULT_HANDOFF_DIR);
- `lib/part2.js:4261` — manifestPath: path.join(projectRoot, MANIFEST_REL),