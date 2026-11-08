# Windows GUI actions require a live nonce/owner/job record and exact owned
# non-input actor + target desktop. Manual invocation on Default fails closed.
# isolation-proof compiles these same guards and performs NO GUI actions.
param([int]$OwnedPid,[string]$Executable,[string]$Profile,[string]$CreationTicks,[string]$Mode='inspect',[string]$Fixture,[string]$ExpectedOrigin,[string]$OwnershipFile)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'native-desktop-guard.ps1')
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'native-desktop-isolation.cs')) + @'

public class NativeProbe {
 [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder value,int size,out int needed);
 public static string Desktop(){int n;var b=new StringBuilder(512);if(!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()),2,b,1024,out n))throw new Exception("Desktop query failed");return b.ToString();}
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] static extern IntPtr NativeReadText(IntPtr h,uint msg,IntPtr w,[Out] StringBuilder text,uint flags,uint timeout,out IntPtr result);
 public static IntPtr ReadText(IntPtr h,uint msg,IntPtr w,StringBuilder text,uint flags,uint timeout,out IntPtr result){Guard(h);return NativeReadText(h,msg,w,text,flags,timeout,out result);}
 public delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr lp);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder b,int max);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int max);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",EntryPoint="ShowWindow")] static extern bool NativeShowWindow(IntPtr h,int cmd);
 public static bool ShowWindow(IntPtr h,int cmd){Guard(h);return NativeShowWindow(h,cmd);}
 [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int size; public uint flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public RECT caretRect; }
 [DllImport("user32.dll",SetLastError=true)] public static extern bool GetGUIThreadInfo(uint thread,ref GUITHREADINFO info);
 public static object Gui(IntPtr h,uint expectedPid){
  NativeDesktopIsolation.GuardWindow(h,expectedPid);
  uint p;uint thread=GetWindowThreadProcessId(h,out p);var g=new GUITHREADINFO();g.size=Marshal.SizeOf(g);
  if(!GetGUIThreadInfo(thread,ref g))throw new Exception("Owned GUI thread query failed");
  // Do not expose handles, identity or metadata of another process's windows.
  return new {window=h.ToInt64(),thread,isolationValidated=true,active=g.active==h,
   ownedActive=g.active!=IntPtr.Zero&&Pid(g.active)==expectedPid,ownedFocus=g.focus!=IntPtr.Zero&&Pid(g.focus)==expectedPid,
   ownedCapture=g.capture!=IntPtr.Zero&&Pid(g.capture)==expectedPid,flags=g.flags};
 }
 [DllImport("user32.dll",EntryPoint="MoveWindow")] static extern bool NativeMoveWindow(IntPtr h,int x,int y,int w,int hgt,bool repaint);
 public static bool MoveWindow(IntPtr h,int x,int y,int w,int hgt,bool repaint){Guard(h);return NativeMoveWindow(h,x,y,w,hgt,repaint);}
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] static extern IntPtr NativeSendText(IntPtr h,uint msg,IntPtr w,string l,uint flags,uint timeout,out IntPtr result);
 public static IntPtr SendText(IntPtr h,uint msg,IntPtr w,string l,uint flags,uint timeout,out IntPtr result){Guard(h);return NativeSendText(h,msg,w,l,flags,timeout,out result);}
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] static extern IntPtr NativeSend(IntPtr h,uint msg,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
 public static IntPtr Send(IntPtr h,uint msg,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result){Guard(h);return NativeSend(h,msg,w,l,flags,timeout,out result);}
 static void Guard(IntPtr h){NativeDesktopIsolation.GuardActor();NativeDesktopIsolation.GuardWindow(h,Pid(h));}
 public static string Class(IntPtr h){var b=new StringBuilder(256);GetClassName(h,b,256);return b.ToString();}
 public static uint Pid(IntPtr h){uint p;GetWindowThreadProcessId(h,out p);return p;}
 public static List<IntPtr> Windows(uint p){NativeDesktopIsolation.GuardProcess((int)p);var a=new List<IntPtr>(); EnumWindows((h,l)=>{if(Pid(h)==p){NativeDesktopIsolation.GuardWindow(h,p);a.Add(h);}return true;},IntPtr.Zero);return a;}
 public static List<IntPtr> Children(IntPtr w){uint p=Pid(w);NativeDesktopIsolation.GuardWindow(w,p);var a=new List<IntPtr>();EnumChildWindows(w,(h,l)=>{NativeDesktopIsolation.GuardWindow(h,p);a.Add(h);return true;},IntPtr.Zero);return a;}
}
'@)
function Verify {
 [NativeDesktopIsolation]::GuardProcess($OwnedPid)
 $p=Get-Process -Id $OwnedPid
 $c=Get-CimInstance Win32_Process -Filter "ProcessId=$OwnedPid"
 if($p.Path -ne $Executable -or $c.ExecutablePath -ne $Executable){throw 'Executable mismatch'}
 if(-not $c.CommandLine.Contains("--user-data-dir=$Profile")){throw 'Owned profile mismatch'}
 $ticks=$p.StartTime.ToUniversalTime().Ticks.ToString()
 if($CreationTicks -and $ticks -ne $CreationTicks){throw 'Creation time mismatch'}
 return $ticks
}
# Read-only readiness observation. A lost target/focus fails; it never restarts
# the interval or sends another action. Kept separate for no-GUI regression tests.
function Wait-PermissionReady([scriptblock]$ReadState,[int]$ExpectedPid,[string]$RuntimeId,[ValidateRange(1,5000)][int]$SettleMs,[hashtable]$Evidence) {
 $clock=New-Object Diagnostics.Stopwatch;$first=$true;$rect=$null
 do {
  $state=& $ReadState
  $Evidence.state=$state
  if(-not $state.isolationValidated -or -not $state.active -or -not $state.focused){throw 'Owned permission focus unavailable before Invoke'}
  if($state.pid -ne $ExpectedPid -or -not $state.enabled -or $state.offscreen -or $state.runtimeId -ne $RuntimeId){throw 'Permission target changed before Invoke'}
  if($first){$rect=$state.rect;$first=$false;$clock.Start()}elseif($state.rect -ne $rect){throw 'Permission target moved before Invoke'}
  if($clock.ElapsedMilliseconds -ge $SettleMs){break}
  Start-Sleep -Milliseconds 50
 } while($true)
 $Evidence.observedMs=$clock.ElapsedMilliseconds
 $Evidence.settled=[DateTime]::UtcNow.ToString('o')
}
$started=[DateTime]::UtcNow.ToString('o')
$phase='verify'
$failure=$null;$ownedProcesses=@();$windows=@();$descriptions=@();$browserUi=@();$action=$null;$guiBefore=@();$guiAfter=@();$permissionAfter=@();$permissionFocus=$null
try {
$phase='isolation-guard'
$isolation=Assert-NativeDesktopIsolation -TargetPid $OwnedPid
$desktop=[NativeProbe]::Desktop()
$actorProcess=Get-Process -Id $PID
$actor=@{pid=$PID;creationTicks=$actorProcess.StartTime.ToUniversalTime().Ticks.ToString();executable=$actorProcess.Path;desktop=$desktop;job=$isolation.job}
if($Mode -eq 'isolation-proof'){
 # No GUI APIs: actual actor + inherited Node target + job + owner identities.
 $refusals=@()
 try {[NativeDesktopIsolation]::GuardProcess([int]$isolation.ownerPid);throw 'Accepted parent outside job'}catch{if($_.Exception.Message -notlike '*outside owned job*'){throw};$refusals+='parent-outside-job'}
 try {[NativeDesktopIsolation]::GuardWindow([IntPtr]::Zero,[uint32]$OwnedPid);throw 'Accepted missing window'}catch{if($_.Exception.Message -notlike '*Target window identity mismatch*'){throw};$refusals+='missing-window'}
 foreach($challenge in @('wrong-desktop','wrong-owner-start','wrong-job')){
  $name=$isolation.desktop;$job=$isolation.job;$ownerStart=[long]$isolation.ownerTicks
  switch($challenge){
   'wrong-desktop' {$name='CodeCityNative-'+[Guid]::NewGuid().ToString('N');$expectedFailure='*desktop mismatch*'}
   'wrong-owner-start' {$ownerStart++;$expectedFailure='*owner identity mismatch*'}
   'wrong-job' {$job+='-missing';$expectedFailure='*Owned job unavailable*'}
  }
  try {[NativeDesktopIsolation]::Configure($name,$job,[int]$isolation.ownerPid,$ownerStart,$isolation.ownerExecutable);throw ('Accepted '+$challenge)}catch{
   if($_.Exception.Message -notlike $expectedFailure){throw};$refusals+=$challenge
  }finally{[NativeDesktopIsolation]::Configure($isolation.desktop,$isolation.job,[int]$isolation.ownerPid,[long]$isolation.ownerTicks,$isolation.ownerExecutable)}
 }
 @{mode=$Mode;desktop=$desktop;actor=$actor;actorPid=$PID;targetPid=$OwnedPid;isolation=$isolation;guardRefusals=$refusals;guiActions=0}|ConvertTo-Json -Depth 6 -Compress
 exit 0
}
$phase='verify'
$ticks=Verify
$ownedProcesses=@(@{pid=$OwnedPid;creationTicks=$ticks;role='browser'})
foreach($c in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$OwnedPid")){
 if($c.ExecutablePath -ne $Executable){continue}
 $cp=Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
 if($cp -and $cp.Path -eq $Executable -and $cp.StartTime.ToUniversalTime().Ticks -ge [long]$ticks -and $c.CommandLine.Contains('--type=')){
 $ownedProcesses+=@{pid=$c.ProcessId;creationTicks=$cp.StartTime.ToUniversalTime().Ticks.ToString();role='chrome-child'}
 }
}
$phase='enumerate-windows'
$windows=@();foreach($op in $ownedProcesses){$windows+=@([NativeProbe]::Windows($op.pid))}
$descriptions=@();$dialogs=@()
foreach($w in $windows){
 $cl=[NativeProbe]::Class($w)
 if($cl -eq '#32770'){
  $dialogs+= $w
  $children=@([NativeProbe]::Children($w)|ForEach-Object { @{handle=$_.ToInt64();class=[NativeProbe]::Class($_);id=[NativeProbe]::GetDlgCtrlID($_);pid=[NativeProbe]::Pid($_)} })
  $descriptions+=@{handle=$w.ToInt64();pid=[NativeProbe]::Pid($w);visible=[NativeProbe]::IsWindowVisible($w);class=$cl;children=$children}
 }
}
$phase='action-'+$Mode
if($Mode -eq 'guard-browser'){
 $main=@($windows|Where-Object{[NativeProbe]::Class($_) -eq 'Chrome_WidgetWin_1' -and [NativeProbe]::Pid($_) -eq $OwnedPid})
 if($main.Count -ne 1){throw 'Expected exactly one isolated browser window'}
 [NativeDesktopIsolation]::GuardWindow($main[0],[uint32]$OwnedPid)
}
$action=$null
if($Mode -eq 'prepare'){
 if((Verify) -ne $ticks){throw 'Process changed'}
 foreach($w in $windows){if([NativeProbe]::Class($w) -eq 'Chrome_WidgetWin_1'){
 if([NativeProbe]::Pid($w) -ne $OwnedPid){throw 'Main window owner changed'}
 [void][NativeProbe]::MoveWindow($w,0,0,900,650,$true)
 [void][NativeProbe]::ShowWindow($w,4)
 }}
 $action=@{mode='prepare';show='SW_SHOWNOACTIVATE';position='owned non-input desktop'}
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
 foreach($handle in $main){$guiBefore+= [NativeProbe]::Gui($handle,$OwnedPid)}
 foreach($el in $all){$cur=$el.Current;$browserUi+=@{type=$cur.ControlType.ProgrammaticName;name=$cur.Name;pid=$cur.ProcessId;automationId=$cur.AutomationId;enabled=$cur.IsEnabled;offscreen=$cur.IsOffscreen;focused=$cur.HasKeyboardFocus;focusable=$cur.IsKeyboardFocusable;runtimeId=($el.GetRuntimeId() -join ':')}}
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
 # Within the validated non-input desktop only, Invoke may activate Chrome
 # and synthesize a click during its input-protection
 # interval. Focus once, then observe an unchanged owned target for the Windows
 # double-click interval used by Chromium. Never repeat focus or Invoke.
 if($main.Count -ne 1){throw 'Expected exactly one permission browser window'}
 $permissionFocus=@{requested=[DateTime]::UtcNow.ToString('o');runtimeId=($buttons[0].GetRuntimeId() -join ':');settleMs=[NativeProbe]::GetDoubleClickTime()}
 [NativeDesktopIsolation]::GuardWindow($main[0],[uint32]$OwnedPid)
 $buttons[0].SetFocus()
 $permissionFocus.returned=[DateTime]::UtcNow.ToString('o')
 $readPermissionState={
  $cur=$buttons[0].Current;$gui=[NativeProbe]::Gui($main[0],$OwnedPid)
  @{isolationValidated=$gui.isolationValidated;active=$gui.active;focused=$cur.HasKeyboardFocus;pid=$cur.ProcessId;enabled=$cur.IsEnabled;offscreen=$cur.IsOffscreen;runtimeId=($buttons[0].GetRuntimeId() -join ':');rect=$cur.BoundingRectangle.ToString()}
 }
 Wait-PermissionReady -ExpectedPid $OwnedPid -RuntimeId $permissionFocus.runtimeId -SettleMs $permissionFocus.settleMs -Evidence $permissionFocus -ReadState $readPermissionState
 if((Verify) -ne $ticks){throw 'Process changed before Invoke'}
 $pattern=$buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
 $current=& $readPermissionState
 foreach($key in $permissionFocus.state.Keys){if($current[$key] -ne $permissionFocus.state[$key]){throw 'Permission readiness changed before Invoke'}}
 $invokedRuntimeId=$current.runtimeId
 $invokeStarted=[DateTime]::UtcNow.ToString('o')
 [NativeDesktopIsolation]::GuardWindow($main[0],[uint32]$OwnedPid)
 $pattern.Invoke()
 $action=@{mode=$Mode;button=$wanted;mechanism='scoped UIAutomation InvokePattern';runtimeId=$invokedRuntimeId;invokeStarted=$invokeStarted;invokeReturned=[DateTime]::UtcNow.ToString('o')}
 foreach($handle in $main){
  $guiAfter+= [NativeProbe]::Gui($handle,$OwnedPid)
  $fresh=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if($fresh.Current.ProcessId -ne $OwnedPid -or (Verify) -ne $ticks){throw 'Post-action root not owned'}
  foreach($el in $fresh.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){
   $cur=$el.Current
   if($cur.ProcessId -eq $OwnedPid -and ($cur.ControlType -eq [System.Windows.Automation.ControlType]::Window -or $cur.Name -eq $wanted)){
    $permissionAfter+=@{type=$cur.ControlType.ProgrammaticName;name=$cur.Name;enabled=$cur.IsEnabled;offscreen=$cur.IsOffscreen;focused=$cur.HasKeyboardFocus;runtimeId=($el.GetRuntimeId() -join ':')}
   }
  }
 }
 }
}
if($Mode -notin @('inspect','prepare','inspect-browser','allow-read','cancel-blocked','guard-browser')){
 if($dialogs.Count -ne 1){throw "Expected exactly one owned dialog, got $($dialogs.Count)"}
 $d=$dialogs[0]
 $dialogPid=[NativeProbe]::Pid($d)
 $dp=@($ownedProcesses|Where-Object {$_.pid -eq $dialogPid})
 if((Verify) -ne $ticks -or -not [NativeProbe]::IsWindow($d) -or $dp.Count -ne 1){throw 'Window ownership changed'}
 $live=Get-Process -Id $dialogPid
 $liveCim=Get-CimInstance Win32_Process -Filter "ProcessId=$dialogPid"
 if($dialogPid -ne $OwnedPid -and $liveCim.ParentProcessId -ne $OwnedPid){throw 'Dialog parent changed'}
 if($live.Path -ne $Executable -or $live.StartTime.ToUniversalTime().Ticks.ToString() -ne $dp[0].creationTicks){throw 'Dialog process changed'}
 [void][NativeProbe]::MoveWindow($d,0,0,900,650,$true)
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
} catch {
 $failure=$_.Exception.Message
}
@{desktop=$desktop;isolation=$isolation;actor=$actor;started=$started;finished=[DateTime]::UtcNow.ToString('o');mode=$Mode;phase=$phase;error=$failure;browserUi=$browserUi;guiBefore=$guiBefore;guiAfter=$guiAfter;permissionAfter=$permissionAfter;permissionFocus=$permissionFocus;ownedProcesses=$ownedProcesses;ownedTopClasses=@($windows|ForEach-Object { @{pid=[NativeProbe]::Pid($_);class=[NativeProbe]::Class($_);visible=[NativeProbe]::IsWindowVisible($_)} });pid=$OwnedPid;executable=$Executable;creationTicks=$ticks;dialogs=$descriptions;action=$action}|ConvertTo-Json -Depth 8 -Compress
if($failure){[Console]::Error.WriteLine($failure);exit 1}
