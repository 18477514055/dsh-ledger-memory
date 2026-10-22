# V3 阶段 0.2：`info.*Rel` 是否被二次拼接到 root

> 生成：node tools/_probe-v3-reljoin-audit.mjs
> 命中 22 处 · 直接使用 info.*Abs 20 次

## ⚠ 命中

- `lib/part2.js:1832` [直接引用 info 的 Rel/Dir 字段] field=decisionsRel — info.decisionsRel === undefined ? undefined : path.resolve(mBase, info.decisionsRel);
- `lib/part2.js:1856` [直接引用 info 的 Rel/Dir 字段] field=archiveRel — info.archiveRel === undefined ? undefined : path.resolve(mBase, info.archiveRel);
- `lib/part2.js:3533` [直接引用 info 的 Rel/Dir 字段] field=activeRel — copies.push(`- 活跃台账：\`${path.join(memBase, info.activeRel)}\`（当前状态，**先读这个**）`);
- `lib/part2.js:3536` [直接引用 info 的 Rel/Dir 字段] field=decisionsRel — copies.push(`- 关键决策：\`${path.join(memBase, info.decisionsRel)}\`（永久保留，不参与归档）`);
- `lib/part2.js:3539` [直接引用 info 的 Rel/Dir 字段] field=archiveRel — copies.push(`- 归档目录：\`${path.join(memBase, info.archiveRel)}\`（旧条目，只追加）`);
- `lib/part2.js:3543` [直接引用 info 的 Rel/Dir 字段] field=logRel — `- 活动日志：\`${path.join(memBase, info.logRel)}\`（**含 L4 用户消息全量**，` +
- `lib/part2.js:3558` [直接引用 info 的 Rel/Dir 字段] field=logRel — //   ★ 收口前这里是**第三处**算法（`path.join(projectRoot, info.logRel, capPeriod, CAPSULE_DIR_NAME)`），
- `lib/part2.js:3566` [直接引用 info 的 Rel/Dir 字段] field=logRel — `（每次压缩存一份，永不覆写；★ 按期间分桶，往上一层 \`${path.join(memBase, info.logRel)}\` 能看到历期）`
- `lib/part2.js:3579` [直接引用 info 的 Rel/Dir 字段] field=handoffLatestRel — `- ★ **上一次交接单**：\`${path.join(memBase, info.handoffLatestRel)}\`（**接手先读这一份**）`
- `lib/part2.js:3582` [直接引用 info 的 Rel/Dir 字段] field=handoffRel — copies.push(`- 交接单目录：\`${path.join(memBase, info.handoffRel)}\`（历次交接都在这里）`);
- `lib/part2.js:3586` [直接引用 info 的 Rel/Dir 字段] field=handoffRel — `- 交接单目录：\`${path.join(memBase, info.handoffRel)}\`（**目前还没有** —— 收尾时用 \`ledger_handoff\` 写一份，新会话就能接上）`
- `lib/part3.js:865` [直接引用 info 的 Rel/Dir 字段] field=handoffLatestRel — `\`${path.join(info.projectRoot, info.handoffLatestRel)}\`\n` +
- `lib/part4.js:55` [直接引用 info 的 Rel/Dir 字段] field=decisionsRel — const abs = path.resolve(mBase, info.decisionsRel);
- `lib/part4.js:82` [直接引用 info 的 Rel/Dir 字段] field=archiveRel — const abs = path.resolve(mBase, info.archiveRel);
- `lib/part4.js:320` [直接引用 info 的 Rel/Dir 字段] field=goalsRel — const gAbs = path.resolve(mBase, info.goalsRel);
- `lib/part4.js:1528` [直接引用 info 的 Rel/Dir 字段] field=archiveRel — const dir = path.resolve(mBase, info.archiveRel);
- `lib/part4.js:3354` [直接引用 info 的 Rel/Dir 字段] field=archiveRel — const archiveAbs = path.resolve(memBase, info.archiveRel);
- `lib/part4.js:3355` [直接引用 info 的 Rel/Dir 字段] field=activeRel — const activeAbs = path.resolve(memBase, info.activeRel);
- `lib/part4.js:4304` [直接引用 info 的 Rel/Dir 字段] field=activeRel — : `- 活跃台账：\`${path.join(memBase, info.activeRel)}\`\n`) +
- `lib/part4.js:4307` [直接引用 info 的 Rel/Dir 字段] field=decisionsRel — : `- 关键决策：\`${path.join(memBase, info.decisionsRel)}\`\n`) +
- `lib/part4.js:4310` [直接引用 info 的 Rel/Dir 字段] field=logRel — : `- 活动日志：\`${path.join(memBase, info.logRel)}\`（用 \`ledger_log\` 按需查）\n`) +
- `lib/part4.js:4313` [直接引用 info 的 Rel/Dir 字段] field=archiveRel — : `- 归档：\`${path.join(memBase, info.archiveRel)}\`\n`);