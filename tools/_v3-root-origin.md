# V3 阶段 0.3：`path.resolve(root, …)` 的函数归属

> 生成：node tools/_probe-v3-root-origin.mjs
> 26 个函数家族 · 疑似记忆路径 29 处 · 需人工确认 11 处

## 判断方式
每一处都归到它所在的函数；函数的**第一个参数名**通常就是 root 的来源。
第二参数名像 `xxxRel` / `relPath` / `fileRel` / `journal` / `archive` 的 ⇒ 倾向记忆根。

### `lib/part7.js` :: `migrateToV3`（首参 `projectRoot`）— 7 处

- L41 [**记忆根?**] `MANIFEST_REL` — const manifestPath = path.join(projectRoot, MANIFEST_REL);
- L58 [待确认] `memDirName` — const memAbs = path.join(projectRoot, memDirName);
- L81 [待确认] `r` — const existing = rels.filter((r) => fs.existsSync(path.join(projectRoot, r)));
- L112 [**记忆根?**] `rel` — const abs = path.join(root, rel);
- L129 [**记忆根?**] `rel` — const from = path.join(projectRoot, rel);
- L152 [待确认] `f` — expected.push({ rel: f, size: fs.statSync(path.join(projectRoot, f)).size, hash: hashOf(path.join(pr
- L242 [**记忆根?**] `rel` — const from = path.join(projectRoot, rel);

### `lib/part2.js` :: `inspect`（首参 `projectRoot`）— 6 处

- L3933 [待确认] `memoryRootRaw` — const cand = path.resolve(projectRoot, memoryRootRaw);
- L3983 [**记忆根?**] `DEFAULT_PRINCIPLES_NAME` — const cand = path.resolve(projectRoot, DEFAULT_PRINCIPLES_NAME);
- L3999 [**记忆根?**] `DEFAULT_GOALS_NAME` — const cand = path.resolve(projectRoot, DEFAULT_GOALS_NAME);
- L4015 [**记忆根?**] `DEFAULT_JOURNAL_NAME` — const cand = path.resolve(projectRoot, DEFAULT_JOURNAL_NAME);
- L4031 [**记忆根?**] `DEFAULT_LESSONS_NAME` — const cand = path.resolve(projectRoot, DEFAULT_LESSONS_NAME);
- L4261 [**记忆根?**] `MANIFEST_REL` — manifestPath: path.join(projectRoot, MANIFEST_REL),

### `lib/part4.js` :: `defineInitTool`（首参 `?`）— 3 处

- L733 [待确认] `memoryRootArg` — const cand = path.resolve(root, memoryRootArg);
- L1306 [**记忆根?**] `MANIFEST_REL` — const mw = writeFileAtomic(path.join(root, MANIFEST_REL), JSON.stringify(manifest, null, 2) + "\n");
- L1379 [**记忆根?**] `MANIFEST_REL` — manifestPath: path.join(root, MANIFEST_REL),

### `lib/part2.js` :: `archiveEvictedUserMessage`（首参 `root`）— 2 处

- L2982 [**记忆根?**] `rel` — //   原来这里自己 `path.join(root, rel, period, USER_MSG_ARCHIVE_FILE)`，
- L2987 [**记忆根?**] `...relFile.split("/"` — const file = path.join(root, ...relFile.split("/"));

### `lib/defs.js` :: `(顶层)`（首参 `?`）— 1 处

- L1929 [待确认] `MIDTURN_DIAG_FILE` — *   ② **只写这一个文件**，路径 = `path.join(projectRoot, MIDTURN_DIAG_FILE)`，

### `lib/part1.js` :: `(顶层)`（首参 `?`）— 1 处

- L2087 [**记忆根?**] `logRel` — *     · 注入里的"历次胶囊"指针： `path.join(projectRoot, logRel, capPeriod, "capsules")`

### `lib/part1.js` :: `bumpRevision`（首参 `root`）— 1 处

- L3536 [**记忆根?**] `MANIFEST_REL` — const w = writeFileAtomic(path.join(root, MANIFEST_REL), JSON.stringify(next, null, 2) + "\n");

### `lib/part1.js` :: `writeManifestMode`（首参 `root`）— 1 处

- L3561 [**记忆根?**] `MANIFEST_REL` — const abs = path.join(root, MANIFEST_REL);

### `lib/part2.js` :: `defineGoalsTool`（首参 `?`）— 1 处

- L1436 [**记忆根?**] `targetRel` — const abs = path.resolve(root, targetRel);

### `lib/part2.js` :: `registerGoalsInManifest`（首参 `root`）— 1 处

- L1545 [**记忆根?**] `MANIFEST_REL` — const abs = path.resolve(root, MANIFEST_REL);

### `lib/part2.js` :: `registerPrinciplesInManifest`（首参 `root`）— 1 处

- L1561 [**记忆根?**] `MANIFEST_REL` — const abs = path.resolve(root, MANIFEST_REL);

### `lib/part2.js` :: `findDeFactoLedger`（首参 `projectRoot`）— 1 处

- L1997 [待确认] `e.name` — lines = countLines(readTextSafe(path.join(projectRoot, e.name)) ?? "");

### `lib/part2.js` :: `logFileRel`（首参 `info`）— 1 处

- L2876 [**记忆根?**] `rel` — return fs.statSync(path.resolve(root, rel)).size;

### `lib/part2.js` :: `renderCapsule`（首参 `info`）— 1 处

- L3558 [**记忆根?**] `info.logRel` — //   ★ 收口前这里是**第三处**算法（`path.join(projectRoot, info.logRel, capPeriod, CAPSULE_DIR_NAME)`），

### `lib/part2.js` :: `readManifest`（首参 `projectRoot`）— 1 处

- L3817 [**记忆根?**] `MANIFEST_REL` — const file = path.join(projectRoot, MANIFEST_REL);

### `lib/part2.js` :: `guessArchiveDir`（首参 `projectRoot`）— 1 处

- L3868 [待确认] `n` — if (fs.statSync(path.join(projectRoot, n)).isDirectory()) return n;

### `lib/part2.js` :: `guessLogDir`（首参 `projectRoot`）— 1 处

- L3887 [待确认] `n` — if (fs.statSync(path.join(projectRoot, n)).isDirectory()) return n;

### `lib/part2.js` :: `findContainerMarker`（首参 `projectRoot`）— 1 处

- L4372 [待确认] `m` — if (fs.statSync(path.join(projectRoot, m)).isFile()) return m;

### `lib/part2.js` :: `installPreCommitHook`（首参 `projectRoot`）— 1 处

- L4769 [待确认] `hp.stdout` — const hooksDir = path.resolve(projectRoot, hp.stdout);

### `lib/part4.js` :: `repairConformance`（首参 `root`）— 1 处

- L33 [**记忆根?**] `MANIFEST_REL` — const manifestPath = path.join(root, MANIFEST_REL);

### `lib/part4.js` :: `detectMigration`（首参 `root`）— 1 处

- L273 [**记忆根?**] `c.rel` — const abs = path.resolve(root, c.rel);

### `lib/part4.js` :: `cardDirAbs`（首参 `root`）— 1 处

- L1888 [**记忆根?**] `dirRel` — return path.resolve(root, dirRel);

### `lib/part4.js` :: `registerCardDirInManifest`（首参 `root`）— 1 处

- L2479 [**记忆根?**] `MANIFEST_REL` — const abs = path.resolve(root, MANIFEST_REL);

### `lib/part5.js` :: `runLedgerSub`（首参 `ctx`）— 1 处

- L1252 [**记忆根?**] `MANIFEST_REL` — `登记位置：\`${path.join(root, MANIFEST_REL)}\`\n\n` +

### `lib/part6.js` :: `walkMarkdown`（首参 `root`）— 1 处

- L286 [**记忆根?**] `dirRel` — const abs = isRoot ? path.resolve(root) : path.resolve(root, dirRel);

### `lib/part6.js` :: `scanMemorySurface`（首参 `root`）— 1 处

- L358 [**记忆根?**] `rel` — const abs = path.resolve(base, rel);
