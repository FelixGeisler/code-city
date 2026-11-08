# Parent is an observer/owner only: no window enumeration, focus or input APIs.
param([Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Evidence,[switch]$Proof)
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'native-desktop-isolation.cs')
$nonce=[Guid]::NewGuid().ToString('N')
$root=Join-Path ([IO.Path]::GetTempPath()) ('code-city-desktop-'+$nonce)
$desktopName='CodeCityNative-'+$nonce
$jobName='Local\CodeCityNative-'+$nonce
$desktop=[IntPtr]::Zero;$job=[IntPtr]::Zero;$child=New-Object NativeDesktopIsolation+Child
$previous=$env:CODE_CITY_NATIVE_ISOLATION_FILE
$result=@{schema=1;nonce=$nonce;desktop=$desktopName;job=$jobName;qualificationEvidence=[IO.Path]::GetFullPath($Evidence);started=[DateTime]::UtcNow.ToString('o');proofOnly=[bool]$Proof;status='failed';recordRoot=$root}
function Quote([string]$Value) {
 # These are paths/known switches, not arbitrary command fragments.
 if($Value.Contains('"') -or $Value.EndsWith('\')){throw 'Unsafe launch argument'}
 return '"'+$Value+'"'
}
try {
 if(Test-Path -LiteralPath $root){throw 'Owned metadata path already exists'}
 [void][IO.Directory]::CreateDirectory($root)
 [void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($Evidence))
 $desktop=[NativeDesktopIsolation]::CreateOwnedDesktop($desktopName)
 $job=[NativeDesktopIsolation]::CreateOwnedJob($jobName)
 $owner=Get-Process -Id $PID
 $record=@{schema=1;nonce=$nonce;desktop=$desktopName;job=$jobName;ownerPid=$PID;ownerTicks=$owner.StartTime.ToUniversalTime().Ticks.ToString();ownerExecutable=$owner.Path}
 $recordPath=Join-Path $root 'ownership.json'
 $record|ConvertTo-Json|Set-Content -LiteralPath $recordPath -Encoding UTF8
 $env:CODE_CITY_NATIVE_ISOLATION_FILE=$recordPath
 $checker=Join-Path $PSScriptRoot 'check-local-folder-native.mjs'
 $arguments=@($Node,$checker)
 if($Proof){$arguments+='--isolation-child-proof'}else{$arguments+='--allow-public-documents-synthetic'}
 $arguments+=@('--evidence',[IO.Path]::GetFullPath($Evidence))
 $command=($arguments|ForEach-Object{Quote $_}) -join ' '
 $child=[NativeDesktopIsolation]::Launch($desktopName,$Node,$command,(Split-Path $PSScriptRoot -Parent))
 $result.child=@{pid=$child.pid;creationTicks=(Get-Process -Id $child.pid).StartTime.ToUniversalTime().Ticks.ToString();executable=$Node;lpDesktop=('WinSta0\'+$desktopName)}
 [NativeDesktopIsolation]::AssignChild($job,$child)
 $record.child=$result.child
 $record|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $recordPath -Encoding UTF8
 $result.owner=$record
 [NativeDesktopIsolation]::Resume($child)
 if([NativeDesktopIsolation]::WaitForSingleObject($child.process,180000) -ne 0){throw 'Owned checker did not exit within 180 seconds'}
 $result.exitCode=[NativeDesktopIsolation]::ExitCode($child)
 if($result.exitCode -ne 0){throw ('Owned checker failed with exit '+$result.exitCode)}
 $result.status='passed'
} catch { $result.error=$_.Exception.Message } finally {
 $env:CODE_CITY_NATIVE_ISOLATION_FILE=$previous
 # No desktop handle release before the entire no-breakaway job has exited.
 try {
  if($job -ne [IntPtr]::Zero){
   $result.activeBeforeCleanup=[NativeDesktopIsolation]::ActiveProcesses($job)
   if($result.activeBeforeCleanup -ne 0){
    $result.status='failed';$result.forcedJobTermination=$true
    $result.retainedWarning='Checker/descendants required forced termination; fixture/profile cleanup is unproved. Inspect qualificationEvidence; do not remove uncertain paths.'
    [NativeDesktopIsolation]::TerminateOwnedJob($job)
    $deadline=[DateTime]::UtcNow.AddSeconds(5)
    while([NativeDesktopIsolation]::ActiveProcesses($job) -ne 0 -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 20}
   }
   $result.remainingProcesses=[NativeDesktopIsolation]::ActiveProcesses($job)
   if($result.remainingProcesses -ne 0){throw 'Owned children remain; desktop record retained'}
  }
  # Even failed job assignment leaves an owned *suspended* child. Its exact
  # process handle must also prove exit before releasing the desktop.
  if($child.process -ne [IntPtr]::Zero -and [NativeDesktopIsolation]::WaitForSingleObject($child.process,0) -ne 0){
   $result.status='failed';$result.forcedChildTermination=$true
   [NativeDesktopIsolation]::TerminateChild($child)
   if([NativeDesktopIsolation]::WaitForSingleObject($child.process,5000) -ne 0){throw 'Exact child did not exit; retain desktop record'}
  }
  $result.childExited=($child.process -eq [IntPtr]::Zero -or [NativeDesktopIsolation]::WaitForSingleObject($child.process,0) -eq 0)
  if($child.thread -ne [IntPtr]::Zero){if(-not [NativeDesktopIsolation]::CloseHandle($child.thread)){throw 'Close child thread failed'}}
  if($child.process -ne [IntPtr]::Zero){if(-not [NativeDesktopIsolation]::CloseHandle($child.process)){throw 'Close child process failed'}}
  if($desktop -ne [IntPtr]::Zero){
   if(-not [NativeDesktopIsolation]::CloseDesktop($desktop)){throw 'Close owned desktop failed'}
   $result.desktopHandleClosed=$true
  }
  $result.desktopAbsent=-not [NativeDesktopIsolation]::DesktopExists($desktopName)
  if(-not $result.desktopAbsent){throw 'Exact owned desktop still exists; record retained'}
  if($job -ne [IntPtr]::Zero){
   if(-not [NativeDesktopIsolation]::CloseHandle($job)){throw 'Close owned job failed'}
  }
  $result.jobAbsent=-not [NativeDesktopIsolation]::JobExists($jobName)
  if(-not $result.jobAbsent){throw 'Exact owned job still exists; record retained'}
  if(Test-Path -LiteralPath $root){
   $files=@(Get-ChildItem -LiteralPath $root -Force)
   if(@($files|Where-Object{$_.Name -ne 'ownership.json' -or $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)}).Count){throw 'Unexpected metadata object; retain'}
   if(Test-Path -LiteralPath (Join-Path $root 'ownership.json')){Remove-Item -LiteralPath (Join-Path $root 'ownership.json')}
   Remove-Item -LiteralPath $root
  }
  $result.metadataAbsent=-not (Test-Path -LiteralPath $root)
 } catch { $result.status='failed';$result.cleanupError=$_.Exception.Message;$result.retainedRecord=$root }
 $result.finished=[DateTime]::UtcNow.ToString('o')
 $output=Join-Path ([IO.Path]::GetFullPath($Evidence)) ('isolation-'+$nonce+'.json')
 $result|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $output -Encoding UTF8
 $result|ConvertTo-Json -Depth 8
}
if($result.status -ne 'passed'){exit 1}
