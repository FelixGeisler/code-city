param([int]$OwnedPid,[string]$Executable,[string]$Profile,[string]$CreationTicks,[string]$Mode='inspect',[string]$Fixture,[string]$ExpectedOrigin,[string]$OwnershipFile)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class NativeProbe {
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr ReadText(IntPtr h,uint msg,IntPtr w,[Out] StringBuilder text,uint flags,uint timeout,out IntPtr result);
 public delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr lp);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder b,int max);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int max);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hgt,bool repaint);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SendText(IntPtr h,uint msg,IntPtr w,string l,uint flags,uint timeout,out IntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] public static extern IntPtr Send(IntPtr h,uint msg,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
 public static string Class(IntPtr h){var b=new StringBuilder(256);GetClassName(h,b,256);return b.ToString();}
 public static uint Pid(IntPtr h){uint p;GetWindowThreadProcessId(h,out p);return p;}
 public static List<IntPtr> Windows(uint p){var a=new List<IntPtr>(); EnumWindows((h,l)=>{if(Pid(h)==p)a.Add(h);return true;},IntPtr.Zero);return a;}
 public static List<IntPtr> Children(IntPtr w){var a=new List<IntPtr>();EnumChildWindows(w,(h,l)=>{a.Add(h);return true;},IntPtr.Zero);return a;}
}
'@
function Verify {
 $p=Get-Process -Id $OwnedPid
 $c=Get-CimInstance Win32_Process -Filter "ProcessId=$OwnedPid"
 if($p.Path -ne $Executable -or $c.ExecutablePath -ne $Executable){throw 'Executable mismatch'}
 if(-not $c.CommandLine.Contains("--user-data-dir=$Profile")){throw 'Owned profile mismatch'}
 $ticks=$p.StartTime.ToUniversalTime().Ticks.ToString()
 if($CreationTicks -and $ticks -ne $CreationTicks){throw 'Creation time mismatch'}
 return $ticks
}
$ticks=Verify
$ownedProcesses=@(@{pid=$OwnedPid;creationTicks=$ticks;role='browser'})
foreach($c in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$OwnedPid")){
 if($c.ExecutablePath -ne $Executable){continue}
 $cp=Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
 if($cp -and $cp.Path -eq $Executable -and $cp.StartTime.ToUniversalTime().Ticks -ge [long]$ticks -and $c.CommandLine.Contains('--type=')){
 $ownedProcesses+=@{pid=$c.ProcessId;creationTicks=$cp.StartTime.ToUniversalTime().Ticks.ToString();role='chrome-child'}
 }
}
$windows=@();foreach($op in $ownedProcesses){$windows+=@([NativeProbe]::Windows($op.pid))}
$descriptions=@();$dialogs=@()
foreach($w in $windows){
 $cl=[NativeProbe]::Class($w)
 if($cl -eq '#32770'){
  $dialogs+= $w
  $children=@([NativeProbe]::Children($w)|ForEach-Object { @{handle=$_.ToInt64();class=[NativeProbe]::Class($_);id=[NativeProbe]::GetDlgCtrlID($_);pid=[NativeProbe]::Pid($_)} })
  $descriptions+=@{handle=$w.ToInt64();class=$cl;children=$children}
 }
}
$action=$null
if($Mode -eq 'prepare'){
 if((Verify) -ne $ticks){throw 'Process changed'}
 foreach($w in $windows){if([NativeProbe]::Class($w) -eq 'Chrome_WidgetWin_1'){
 if([NativeProbe]::Pid($w) -ne $OwnedPid){throw 'Main window owner changed'}
 [void][NativeProbe]::MoveWindow($w,-22000,-22000,900,650,$true)
 [void][NativeProbe]::ShowWindow($w,4)
 }}
 $action=@{mode='prepare';show='SW_SHOWNOACTIVATE';position='offscreen'}
}
$browserUi=@()
if($Mode -in @('inspect-browser','allow-read','cancel-blocked')){
 Add-Type -AssemblyName UIAutomationClient
 Add-Type -AssemblyName UIAutomationTypes
 $main=@($windows|Where-Object{[NativeProbe]::Class($_) -eq 'Chrome_WidgetWin_1' -and [NativeProbe]::Pid($_) -eq $OwnedPid})
 if($main.Count -lt 1 -or (Verify) -ne $ticks){throw 'Owned browser window unavailable'}
 $all=@();$seen=@{}
 foreach($handle in $main){
 if([NativeProbe]::Pid($handle) -ne $OwnedPid -or (Verify) -ne $ticks){throw 'Window owner changed'}
 $element=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
 if($element.Current.ProcessId -ne $OwnedPid){throw 'Automation root not owned'}
 $descendants=$element.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
 foreach($el in $descendants){$key=($el.GetRuntimeId() -join ':');if(-not $seen.ContainsKey($key)){$seen[$key]=$true;$all+=$el}}
 }
 foreach($el in $all){$cur=$el.Current;$browserUi+=@{type=$cur.ControlType.ProgrammaticName;name=$cur.Name;pid=$cur.ProcessId;automationId=$cur.AutomationId}}
 if($Mode -eq 'allow-read' -or $Mode -eq 'cancel-blocked'){
 $wanted='Allow'
 if($Mode -eq 'allow-read'){
 $ownership=Get-Content -LiteralPath $OwnershipFile -Raw|ConvertFrom-Json
 if($Fixture -notin @($ownership.fixture,$ownership.empty)){throw 'Permission folder not owned'}
 if(-not @($browserUi|Where-Object{$_.type -eq 'ControlType.Window' -and $_.name -eq 'Allow this site to view and copy files?'}).Count){throw 'Expected directory read permission prompt'}
 $expected=$ExpectedOrigin+' will be able to view and make its own copies of files in '+[System.IO.Path]::GetFileName($Fixture)
 if(-not $ExpectedOrigin.StartsWith('http://127.0.0.1:') -or -not @($browserUi|Where-Object{$_.name -eq $expected -and $_.pid -eq $OwnedPid}).Count){throw 'Permission prompt folder/origin mismatch'}
 }
 if($Mode -eq 'cancel-blocked'){
 if(-not @($browserUi|Where-Object{$_.type -eq 'ControlType.Window' -and $_.name -eq "Can't open this folder"}).Count){throw 'Expected sensitive-folder refusal dialog'}
 $wanted='Cancel'
 }
 $buttons=@($all|Where-Object{$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq $wanted})
 if($buttons.Count -ne 1){throw 'Expected unique View files permission button'}
 if((Verify) -ne $ticks -or $buttons[0].Current.ProcessId -ne $OwnedPid){throw 'Permission control not owned'}
 $pattern=$buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
 $pattern.Invoke()
 $action=@{mode=$Mode;button=$wanted;mechanism='scoped UIAutomation InvokePattern'}
 }
}
if($Mode -notin @('inspect','prepare','inspect-browser','allow-read','cancel-blocked')){
 if($dialogs.Count -ne 1){throw "Expected exactly one owned dialog, got $($dialogs.Count)"}
 $d=$dialogs[0]
 $dialogPid=[NativeProbe]::Pid($d)
 $dp=@($ownedProcesses|Where-Object {$_.pid -eq $dialogPid})
 if((Verify) -ne $ticks -or -not [NativeProbe]::IsWindow($d) -or $dp.Count -ne 1){throw 'Window ownership changed'}
 $live=Get-Process -Id $dialogPid
 $liveCim=Get-CimInstance Win32_Process -Filter "ProcessId=$dialogPid"
 if($dialogPid -ne $OwnedPid -and $liveCim.ParentProcessId -ne $OwnedPid){throw 'Dialog parent changed'}
 if($live.Path -ne $Executable -or $live.StartTime.ToUniversalTime().Ticks.ToString() -ne $dp[0].creationTicks){throw 'Dialog process changed'}
 [void][NativeProbe]::MoveWindow($d,-22000,-22000,900,650,$true)
 $controls=@([NativeProbe]::Children($d))
 $r=[IntPtr]::Zero
 if($Mode -eq 'select'){
  $ownership=Get-Content -LiteralPath $OwnershipFile -Raw|ConvertFrom-Json
  if($Fixture -notin @($ownership.fixture,$ownership.empty)){throw 'Not owned synthetic fixture'}
  if([System.IO.Path]::GetDirectoryName($Fixture) -ne 'C:\Users\Public\Documents' -or [System.IO.Path]::GetFileName($Fixture) -notmatch '^CodeCitySynthetic-[a-f0-9-]+(-empty)?$'){throw 'Outside authorized synthetic boundary'}
  $item=Get-Item -LiteralPath $Fixture -Force
  if(-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)){throw 'Fixture is not a regular owned directory'}
  $edit=@($controls|Where-Object { [NativeProbe]::Class($_) -eq 'Edit' -and [NativeProbe]::GetDlgCtrlID($_) -eq 1152 })
  if($edit.Count -ne 1){throw 'Verified folder edit 1152 unavailable'}
  if([NativeProbe]::Pid($edit[0]) -ne $dialogPid){throw 'Edit not owned'}
  $ok=[NativeProbe]::SendText($edit[0],0x000C,[IntPtr]::Zero,$Fixture,2,2000,[ref]$r)
  if($ok -eq [IntPtr]::Zero){throw 'WM_SETTEXT failed'}
  $text=New-Object System.Text.StringBuilder 32768
  [void][NativeProbe]::ReadText($edit[0],0x000D,[IntPtr]32768,$text,2,2000,[ref]$r)
  if($text.ToString() -ne $Fixture){throw 'Selected synthetic folder field did not match'}
  $verifiedFolder=$text.ToString()
  $id=1
 }elseif($Mode -eq 'confirm'){$id=1}elseif($Mode -eq 'cancel'){$id=2}else{throw 'Invalid mode'}
 $button=@($controls|Where-Object{[NativeProbe]::Class($_) -eq 'Button' -and [NativeProbe]::GetDlgCtrlID($_) -eq $id})
 if($button.Count -ne 1 -or [NativeProbe]::Pid($button[0]) -ne $dialogPid){throw 'Owned button unavailable'}
 if((Verify) -ne $ticks){throw 'Process changed'}
 $ok=[NativeProbe]::Send($button[0],0x00F5,[IntPtr]::Zero,[IntPtr]::Zero,2,2000,[ref]$r)
 $action=@{mode=$Mode;verifiedFolder=$verifiedFolder;button=$id;sendCompleted=($ok -ne [IntPtr]::Zero)}
}
@{browserUi=$browserUi;ownedProcesses=$ownedProcesses;ownedTopClasses=@($windows|ForEach-Object { @{pid=[NativeProbe]::Pid($_);class=[NativeProbe]::Class($_);visible=[NativeProbe]::IsWindowVisible($_)} });pid=$OwnedPid;executable=$Executable;creationTicks=$ticks;dialogs=$descriptions;action=$action}|ConvertTo-Json -Depth 8 -Compress
