# Issue tracker: GitHub

本仓库的 issues 和 specs 存放在 GitHub Issues，使用 gh CLI 操作。
在仓库目录内运行，由 gh 根据 Git remote 确定仓库。

## 常用操作

- 创建：`gh issue create --title "..." --body-file <正文文件>`
- 读取：`gh issue view <number> --json number,title,body,labels,comments`
- 列表：`gh issue list --state open --json number,title,body,labels`
- 评论：`gh issue comment <number> --body-file <正文文件>`
- 添加标签：`gh issue edit <number> --add-label "..."`
- 移除标签：`gh issue edit <number> --remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

多行正文保存到临时文件，通过 `--body-file` 传入。
技能要求“发布到 issue tracker”时，创建 GitHub issue；
要求“获取相关 ticket”时，读取对应 issue 及其评论。

## Pull requests as a triage surface

PRs as a request surface: no.

## Wayfinding operations

使用带 `wayfinder:map` 标签的 issue 保存任务地图和决策。
子任务通过 GitHub sub-issues 关联；不可用时，在地图正文中使用
任务清单，并在子任务正文顶部注明 `Part of #<map>`。

任务类型标签使用 `wayfinder:research`、`wayfinder:prototype`、
`wayfinder:grilling` 或 `wayfinder:task`。

阻塞关系优先使用 GitHub 原生 issue dependencies；
不可用时，在任务正文顶部注明 `Blocked by: #<number>`。
只有所有阻塞任务均已关闭，任务才可推进。

按地图顺序选择首个未分配、未被阻塞的开放任务。
认领使用 `gh issue edit <number> --add-assignee @me`。
完成后评论结论、关闭任务，并更新地图中的决策与上下文链接。
