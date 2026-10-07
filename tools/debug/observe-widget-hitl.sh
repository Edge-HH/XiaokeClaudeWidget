#!/usr/bin/env bash
# diagnosing-bugs HITL template: only read the existing XiaokeWidget process.
set -euo pipefail
step() { printf '\n>>> %s\n' "$1"; read -r -p '    [Enter when done] ' _; }
capture() { local var="$1" question="$2" answer; printf '\n>>> %s\n' "$question"; read -r -p '    > ' answer; printf -v "$var" '%s' "$answer"; }
artifacts=".test-artifacts/observe-widget-$(date +%s)"
pwsh.exe -NoProfile -File tools/debug/observe-widget.ps1 -WidgetProcessId "$1" -Artifacts "$artifacts" &
observer_pid=$!
for ((i=0;i<100;i++)); do [[ -f "$artifacts/ready" ]] && break; sleep .1; done
step '在仍运行的 0.1.1 中右键小克托盘图标，关闭菜单，尝试重复两三次。此脚本只读小克自身窗口，不运行或调用 Claude。'
capture STUCK '是否卡住？输入 yes 或 no。'
printf '%s\n' "$STUCK" > "$artifacts/answer"
wait "$observer_pid"
