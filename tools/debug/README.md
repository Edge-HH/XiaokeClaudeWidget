# 临时诊断

这里存放本次托盘边缘问题的探索工具，不参与正式验收或打包。

`observe-widget-hitl.sh` 从 diagnosing-bugs 的 HITL 模板改编，配合 `observe-widget.ps1` 只读现有小克窗口及其角色图像的物理边界。不会激活窗口、启动 Claude、读取宿主内容、查询账号或输出凭据。运行时给出小克主进程 PID，按提示复现；输出在 `.test-artifacts/observe-widget-*/trace.json`。坐标越界持续超过 700 毫秒时报告 RED。

正式回归使用 `tests/viewport-recovery.mjs`，会启动本项目模拟宿主、假数据以及隔离的测试配置目录。
