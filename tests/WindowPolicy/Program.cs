using XiaokeWindowBridge;

// 只有整数假句柄和假的窗口 owner 链；不会调用 Win32、启动宿主或发起额度查询。
var owners = new Dictionary<nint, nint> { [2] = 1, [3] = 2, [5] = 99, [6] = 7, [7] = 6 };
bool Candidate(nint window) => window is 1 or 2 or 4 or 5;
nint Owner(nint window) => owners.GetValueOrDefault(window);
void Equal<T>(T actual, T expected, string message) { if (!EqualityComparer<T>.Default.Equals(actual, expected)) throw new Exception(message); }

Equal(HostWindowPolicy.ResolveForegroundHost(2, 1, Candidate, Owner), (nint)1, "宿主的普通 owned 对话框不能让宠物转贴对话框");
Equal(HostWindowPolicy.ResolveForegroundHost(3, 1, Candidate, Owner), (nint)1, "宿主的 owned 工具弹窗必须保留宿主");
Equal(HostWindowPolicy.IsHostForeground(3, 1, Owner), true, "owned 弹窗在前台时不能把宠物隐藏");
Equal(HostWindowPolicy.ResolveForegroundHost(4, 1, Candidate, Owner), (nint)4, "切换独立宿主窗口时应跟随新宿主");
Equal(HostWindowPolicy.ResolveForegroundHost(5, 0, Candidate, Owner), (nint)5, "首次发现带 owner 的正常主窗口仍可作为宿主");
Equal(HostWindowPolicy.IsHostForeground(4, 1, Owner), false, "不相关窗口取得前台后必须隐藏旧宿主宠物");
Equal(HostWindowPolicy.IsHostForeground(6, 1, Owner), false, "异常 owner 环不能死循环或误认前台");
Equal(HostWindowPolicy.IsHostForeground(0, 1, Owner), false, "空前台不能误认宿主");
Console.WriteLine("窗口宿主离线策略验收通过：8 个断言，未访问任何实际窗口或服务。");
