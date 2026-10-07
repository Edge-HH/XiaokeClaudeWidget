using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Collections.Concurrent;

namespace XiaokeWindowBridge;

internal static class Program
{
    private static nint tracked;
    private static nint mockHandle;
    private static uint overlayPid;
    private static string previous = "";
    // Windows 激活切换会短暂返回空前台；只缓冲这段空值，其他应用取得前台后立即生效。
    private const long ForegroundTransitionGraceMilliseconds = 150;
    private static nint lastStableForeground;
    private static long lastStableForegroundObservedAt;
    private static volatile bool stopping;
    private static readonly ConcurrentQueue<string> Commands = new();
    private static readonly Native.WinEventDelegate Callback = OnEvent;
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    [STAThread]
    private static int Main(string[] args)
    {
        var production = args.Contains("--production");
        var mockIndex = Array.IndexOf(args, "--mock-hwnd");
        if (production == (mockIndex >= 0)) return 2;
        if (mockIndex >= 0 && (mockIndex + 1 >= args.Length || !long.TryParse(args[mockIndex + 1], out var handle))) return 2;
        if (mockIndex >= 0)
        {
            mockHandle = new nint(long.Parse(args[mockIndex + 1]));
            if (mockHandle == 0) return 2;
        }
        var pidIndex = Array.IndexOf(args, "--overlay-pid");
        if (pidIndex < 0 || pidIndex + 1 >= args.Length || !uint.TryParse(args[pidIndex + 1], out overlayPid)) return 2;
        if (mockHandle != 0)
        {
            Native.GetWindowThreadProcessId(mockHandle, out var mockPid);
            if (mockPid != overlayPid) return 2;
        }
        // 物理坐标由 Electron 在窗口所属显示器上转换成 DIP；不更改宿主的 DPI 模式。
        Native.SetProcessDpiAwarenessContext(new nint(-4));
        using var parent = System.Diagnostics.Process.GetProcessById((int)overlayPid);
        using var timer = new System.Windows.Forms.Timer { Interval = 100 };
        var foregroundHook = Native.SetWinEventHook(3, 3, 0, Callback, 0, 0, 2);
        var windowHook = Native.SetWinEventHook(0x8000, 0x800B, 0, Callback, 0, 0, 2);
        timer.Tick += (_, _) => {
            if (stopping || parent.HasExited) { Application.ExitThread(); return; }
            while (Commands.TryDequeue(out var command))
            {
                // 生产模式仅新增只读刷新；原生输入仍严格限于 mock。
                if (command == "refresh") Update(true);
                else TestInput(command);
            }
            Update();
        };
        _ = Task.Run(() => { while (Console.ReadLine() is { } line) { if (line == "stop") break; if (line.Length < 2048) Commands.Enqueue(line); } stopping = true; });
        Console.WriteLine(JsonSerializer.Serialize(new { Type = "mode", Mode = mockHandle != 0 ? "mock" : "production" }, Json));
        Console.Out.Flush();
        timer.Start(); Update();
        Application.Run();
        if (foregroundHook != 0) Native.UnhookWinEvent(foregroundHook);
        if (windowHook != 0) Native.UnhookWinEvent(windowHook);
        return 0;
    }
    private static void OnEvent(nint hook, uint eventType, nint hwnd, int objectId, int childId, uint thread, uint time)
    {
        if (eventType == 3 || hwnd == tracked || eventType is 0x8000 or 0x8001) Update();
    }
    private static void TestInput(string command)
    {
        // 原生输入仅存在于 mock 模式，并检查当前前台及落点窗口都属于本项目。
        // 生产模式不执行这些命令，不能用它控制 Claude 或任何其他应用。
        var id = 0;
        try
        {
            using var json = JsonDocument.Parse(command);
            var root = json.RootElement; id = root.GetProperty("id").GetInt32();
            if (mockHandle == 0 || !Native.IsWindow(mockHandle)) throw new InvalidOperationException("非模拟模式");
            var action = root.GetProperty("action").GetString();
            if (action == "style")
            {
                var window = new nint(long.Parse(root.GetProperty("hwnd").GetString()!));
                Native.GetWindowThreadProcessId(window, out var windowPid);
                if (windowPid != overlayPid) throw new InvalidOperationException("只允许检查本项目窗口");
                var flags = Native.GetWindowLongPtr(window, -20).ToInt64();
                Console.WriteLine(JsonSerializer.Serialize(new { Type = "test-input", Id = id, Ok = true, Payload = new { Transparent = (flags & 0x20) != 0, NoActivate = (flags & 0x08000000) != 0 } }, Json)); Console.Out.Flush(); return;
            }
            if (action == "focus")
            {
                Native.ShowWindow(mockHandle, 9);
                Native.SetForegroundWindow(mockHandle);
                Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out var activePid);
                if (activePid != overlayPid) throw new InvalidOperationException("系统未允许模拟宿主取得前台");
                Console.WriteLine(JsonSerializer.Serialize(new { Type = "test-input", Id = id, Ok = true }, Json)); Console.Out.Flush(); return;
            }
            var point = new Native.Point { X = root.GetProperty("x").GetInt32(), Y = root.GetProperty("y").GetInt32() };
            Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out var foregroundPid);
            Native.GetWindowThreadProcessId(Native.WindowFromPoint(point), out var targetPid);
            var client = new Native.Point(); Native.ClientToScreen(mockHandle, ref client); Native.GetClientRect(mockHandle, out var rect);
            if (foregroundPid != overlayPid) throw new InvalidOperationException("当前前台不属于本项目");
            if (targetPid != overlayPid) throw new InvalidOperationException("落点窗口不属于本项目");
            if (point.X < client.X || point.Y < client.Y || point.X >= client.X + rect.Right || point.Y >= client.Y + rect.Bottom) throw new InvalidOperationException("落点超出模拟宿主客户区");
            Native.SetCursorPos(point.X, point.Y);
            if (action is "click" or "right-click")
            {
                var flags = action == "click" ? new uint[] { 2, 4 } : new uint[] { 8, 16 };
                var inputs = flags.Select(flag => new Native.Input { Type = 0, Union = new Native.InputUnion { Mouse = new Native.MouseInput { Flags = flag } } }).ToArray();
                if (Native.SendInput(2, inputs, Marshal.SizeOf<Native.Input>()) != 2) throw new InvalidOperationException("系统拒绝模拟输入");
            }
            Console.WriteLine(JsonSerializer.Serialize(new { Type = "test-input", Id = id, Ok = true }, Json));
        }
        catch (Exception error) { Console.WriteLine(JsonSerializer.Serialize(new { Type = "test-input", Id = id, Ok = false, Reason = error is InvalidOperationException ? error.Message : "无效模拟命令" }, Json)); }
        Console.Out.Flush();
    }
    private static bool IsCandidate(nint hwnd)
    {
        if (hwnd == 0 || !Native.IsWindowVisible(hwnd)) return false;
        // owner 不代表子窗口：正常的顶层客户端也可以带 owner。按窗口样式排除
        // 子窗口/工具窗口，不能把所有 GW_OWNER 非空的宿主一概排除。
        var style = Native.GetWindowLongPtr(hwnd, -16).ToInt64();
        var extended = Native.GetWindowLongPtr(hwnd, -20).ToInt64();
        if ((style & 0x40000000L) != 0 || (extended & 0x80L) != 0) return false;
        if (!Native.IsIconic(hwnd) && (!Native.GetClientRect(hwnd, out var client) || client.Right <= client.Left || client.Bottom <= client.Top)) return false;
        Native.GetWindowThreadProcessId(hwnd, out var pid);
        var process = Native.OpenProcess(0x1000, false, pid);
        if (process == 0) return false;
        try
        {
            var text = new StringBuilder(1024); var length = text.Capacity;
            return Native.QueryFullProcessImageName(process, 0, text, ref length) && Path.GetFileName(text.ToString()).Equals("Claude.exe", StringComparison.OrdinalIgnoreCase);
        }
        finally { Native.CloseHandle(process); }
    }
    private static void Update(bool force = false)
    {
        // 本次输出的候选选择、宿主前台和小克前台都使用同一份 Win32 快照，
        // 避免窗口激活过程中多次 GetForegroundWindow 得到互相矛盾的状态。
        var foreground = Native.GetForegroundWindow();
        var observedAt = Environment.TickCount64;
        if (foreground != 0)
        {
            lastStableForeground = foreground;
            lastStableForegroundObservedAt = observedAt;
        }
        else if (lastStableForeground != 0 && Native.IsWindow(lastStableForeground) &&
                 observedAt - lastStableForegroundObservedAt <= ForegroundTransitionGraceMilliseconds)
        {
            foreground = lastStableForeground;
        }
        nint foregroundRoot = foreground == 0 ? 0 : Native.GetAncestor(foreground, 2); // GA_ROOT，只读。
        uint foregroundPid = 0;
        if (foreground != 0) Native.GetWindowThreadProcessId(foreground, out foregroundPid);
        // 模拟模式绝不枚举或查找真实 Claude 窗口。
        if (mockHandle != 0)
        {
            Native.GetWindowThreadProcessId(mockHandle, out var mockPid);
            // 关闭后 HWND 可能被系统复用，不能观察后来占用同一句柄的外部窗口。
            tracked = Native.IsWindow(mockHandle) && mockPid == overlayPid ? mockHandle : 0;
        }
        else
        {
            if (IsCandidate(foregroundRoot)) tracked = foregroundRoot;
            else if (!IsCandidate(tracked))
            {
                tracked = 0;
                Native.EnumWindows((hwnd, _) => { if (IsCandidate(hwnd)) { tracked = hwnd; return false; } return true; }, 0);
            }
        }
        object? host = null;
        if (tracked != 0 && Native.GetClientRect(tracked, out var rect))
        {
            var point = new Native.Point(); Native.ClientToScreen(tracked, ref point);
            Native.GetWindowThreadProcessId(tracked, out var pid);
            var cloaked = 0; Native.DwmGetWindowAttribute(tracked, 14, out cloaked, sizeof(int));
            host = new { Hwnd = tracked.ToInt64().ToString(), ProcessId = pid, X = point.X, Y = point.Y, Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top, Dpi = Native.GetDpiForWindow(tracked), Foreground = foregroundRoot == tracked, Minimized = Native.IsIconic(tracked), Visible = Native.IsWindowVisible(tracked) && cloaked == 0, Above = Native.GetWindow(tracked, 3).ToInt64().ToString() };
        }
        // 小克设置/编辑取得前台与宿主前台分别报告，主进程负责交互期间的显示策略。
        var output = JsonSerializer.Serialize(new { Type = "host", Host = host, OwnForeground = foregroundPid == overlayPid }, Json);
        if (force || output != previous) { previous = output; Console.WriteLine(output); Console.Out.Flush(); }
    }
}

internal static class Native
{
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { internal int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct MouseInput { internal int X, Y; internal uint Data, Flags, Time; internal nuint Extra; }
    [StructLayout(LayoutKind.Explicit)] internal struct InputUnion { [FieldOffset(0)] internal MouseInput Mouse; }
    [StructLayout(LayoutKind.Sequential)] internal struct Input { internal uint Type; internal InputUnion Union; }
    internal delegate bool EnumDelegate(nint hwnd, nint data);
    internal delegate void WinEventDelegate(nint hook, uint eventType, nint hwnd, int objectId, int childId, uint thread, uint time);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumDelegate callback, nint data);
    [DllImport("user32.dll")] internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern nint GetAncestor(nint hwnd, uint flags);
    [DllImport("user32.dll")] internal static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] internal static extern nint GetWindow(nint hwnd, uint command);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool ClientToScreen(nint hwnd, ref Point point);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] internal static extern nint WindowFromPoint(Point point);
    [DllImport("user32.dll")] internal static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] internal static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] internal static extern nint GetWindowLongPtr(nint hwnd, int index);
    [DllImport("user32.dll")] internal static extern nint SetWinEventHook(uint min, uint max, nint module, WinEventDelegate callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] internal static extern bool UnhookWinEvent(nint hook);
    [DllImport("kernel32.dll")] internal static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern bool QueryFullProcessImageName(nint process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(nint handle);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint hwnd, uint attribute, out int value, int size);
}
