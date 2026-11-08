# No GUI APIs. Only previously recorded PID/start/executable identities.
param([string]$IdentitiesJson,[string]$Executable,[switch]$Terminate)
$ErrorActionPreference='Stop'
function Get-OwnedProcessState($Process,[string]$Ticks,[string]$ExpectedExecutable) {
 # GetProcessById does not retain a handle. Bind before ANY identity/liveness
 # check so those checks and Kill use the same kernel process, never a reused
 # PID. Failure to open throws (fail closed); the caller retains this Process
 # through termination and disposes it in finally on every outcome.
 [void]$Process.Handle
 # A bound process can still exit; its start time is not liveness evidence.
 if($Process.StartTime.ToUniversalTime().Ticks.ToString() -ne $Ticks){return 'reused'}
 if($Process.HasExited){return 'exited'}
 if($Process.Path -ine $ExpectedExecutable){
  # Exit can race the module/path query too; no unproved process is signalled.
  if($Process.HasExited){return 'exited'}
  throw 'Owned process executable mismatch'
 }
 if($Process.HasExited){return 'exited'}
 return 'live'
}
if($IdentitiesJson){
 $result=@{remaining=@();exited=@();absent=@();reused=@();stopped=@()}
 foreach($identity in ($IdentitiesJson|ConvertFrom-Json)){
  $p=$null
  try {
   try{$p=[Diagnostics.Process]::GetProcessById([int]$identity.pid)}catch [ArgumentException]{$result.absent+=,$identity;continue}
   $state=Get-OwnedProcessState $p $identity.ticks $Executable
   if($state -eq 'live'){
    if($Terminate){$p.Kill();$result.stopped+=,$identity}else{$result.remaining+=,$identity}
   }else{$result[$state]+=,$identity}
  } finally {if($p){$p.Dispose()}}
 }
 $result|ConvertTo-Json -Depth 5 -Compress
}
