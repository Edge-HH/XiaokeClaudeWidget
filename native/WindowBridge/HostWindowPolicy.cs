namespace XiaokeWindowBridge;

/** 宿主选择仅依赖已观察到的窗口关系，便于用离线假句柄验收，不访问任何应用。 */
internal static class HostWindowPolicy
{
    internal static nint ResolveForegroundHost(nint foregroundRoot, nint tracked, Func<nint, bool> isCandidate, Func<nint, nint> owner)
    {
        // 已跟踪主窗口拥有的对话框/菜单只改变前台，不能把宠物位置改成弹窗客户区。
        // 没有这种关联时仍接受普通带 owner 的主窗口，避免一概排除合法宿主。
        if (tracked != 0 && isCandidate(tracked) && IsHostForeground(foregroundRoot, tracked, owner)) return tracked;
        return isCandidate(foregroundRoot) ? foregroundRoot : 0;
    }

    internal static bool IsHostForeground(nint foregroundRoot, nint tracked, Func<nint, nint> owner)
    {
        if (tracked == 0) return false;
        var visited = new HashSet<nint>();
        for (var current = foregroundRoot; current != 0 && visited.Add(current) && visited.Count <= 32; current = owner(current))
        {
            if (current == tracked) return true;
        }
        return false;
    }
}
