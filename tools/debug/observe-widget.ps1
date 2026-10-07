param([Parameter(Mandatory=$true)][int]$WidgetProcessId, [Parameter(Mandatory=$true)][string]$Artifacts)
$ErrorActionPreference='Stop'
$processInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$WidgetProcessId"
if ($processInfo.Name -ne 'XiaokeWidget.exe') { throw 'Only the existing XiaokeWidget process can be observed' }
New-Item -ItemType Directory -Path $Artifacts -Force | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class OwnPetProbe {
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr param);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder title,int length);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 public static long Find(uint owner) {long found=0;EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid!=owner)return true;var title=new StringBuilder(256);GetWindowText(h,title,256);if(title.ToString()=="小克额度宠物"){found=h.ToInt64();return false;}return true;},IntPtr.Zero);return found;}
 public static object Read(long handle,uint owner) {var h=new IntPtr(handle);uint pid;GetWindowThreadProcessId(h,out pid);if(pid!=owner)throw new Exception("Window owner changed");var old=SetThreadDpiAwarenessContext(new IntPtr(-4));try{Rect r;GetClientRect(h,out r);var p=new Point();ClientToScreen(h,ref p);return new{Visible=IsWindowVisible(h),Left=p.X,Top=p.Y,Width=r.Right,Height=r.Bottom};}finally{SetThreadDpiAwarenessContext(old);}}
}
'@
# Read only our pet's bounds, never host content, controls, credentials or account data.
$conditions=@((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Image)), (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'DeepSeek 余额')))
$imageCondition=New-Object System.Windows.Automation.AndCondition(,$conditions)
$samples=New-Object System.Collections.Generic.List[object]
$deadline=(Get-Date).AddMinutes(3)
$answerPath=Join-Path $Artifacts 'answer'
$failureStart=$null
$maxClippedMs=0
Set-Content -LiteralPath (Join-Path $Artifacts 'ready') -Value 'ready'
Write-Output 'Ready: observing only the running XiaokeWidget window and its pet image.'
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $answerPath)) {
 $handle=[OwnPetProbe]::Find($WidgetProcessId)
 if (-not $handle) { break }
 $window=[OwnPetProbe]::Read($handle,$WidgetProcessId)
 $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
 $image=$root.FindFirst([System.Windows.Automation.TreeScope]::Subtree,$imageCondition)
 $ratio=$null;$rectangle=$null
 if ($image -and $window.Visible) {
  $r=$image.Current.BoundingRectangle
  $rectangle=@{left=$r.X;top=$r.Y;width=$r.Width;height=$r.Height}
  if ($r.Width -gt 0 -and $r.Height -gt 0) {
   $overlapW=[Math]::Max(0,[Math]::Min($r.Right,$window.Left+$window.Width)-[Math]::Max($r.Left,$window.Left))
   $overlapH=[Math]::Max(0,[Math]::Min($r.Bottom,$window.Top+$window.Height)-[Math]::Max($r.Top,$window.Top))
   $ratio=$overlapW*$overlapH/($r.Width*$r.Height)
  }
 }
 $now=Get-Date
 if ($null -ne $ratio -and $ratio -lt .5) {
  if (-not $failureStart) { $failureStart=$now }
  $maxClippedMs=[Math]::Max($maxClippedMs,($now-$failureStart).TotalMilliseconds)
 } else { $failureStart=$null }
 $samples.Add(@{at=$now.ToUniversalTime().ToString('o');window=$window;image=$rectangle;visibleRatio=$ratio})
 Start-Sleep -Milliseconds 200
}
$answer=if (Test-Path -LiteralPath $answerPath) { Get-Content -LiteralPath $answerPath -Raw } else { 'timeout' }
@{answer=$answer.Trim();maxClippedMs=$maxClippedMs;samples=$samples} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Artifacts 'trace.json') -Encoding utf8
Write-Output ('Longest clipping: '+$maxClippedMs+' ms')
if ($maxClippedMs -ge 700) { Write-Output 'RED: the pet remains clipped at the edge'; exit 1 }
Write-Output 'No persistent clipping captured.'
