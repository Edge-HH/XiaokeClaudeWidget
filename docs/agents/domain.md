# Domain docs

## 探索代码前

读取根目录 `CONTEXT.md`，以及 `docs/adr/` 中与当前任务相关的 ADR。
这些文件不存在时，静默继续；在实际明确术语或架构决策后，
由 domain-modeling 技能按需创建。

## 布局

本仓库采用 single-context：
- `CONTEXT.md`：领域术语与上下文。
- `docs/adr/`：架构决策记录。

## 使用规则

任务标题、设计建议、诊断假设和测试名称使用 `CONTEXT.md`
定义的术语。遇到术语缺口，记录给 domain-modeling 处理。

建议与已有 ADR 冲突时，明确指出相关 ADR 和重新考虑的理由。
