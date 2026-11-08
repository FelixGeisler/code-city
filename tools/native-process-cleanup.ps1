# No GUI APIs. Only previously recorded PID/start/executable identities.
param([string]$IdentitiesJson,[string]$Executable,[switch]$Terminate)
$ErrorActionPreference='Stop'
function Get-OwnedProcessState($Process,[string]$Ticks,[string]$ExpectedExecutable) {
 # A Process obtained while live may have exited before this check. Its start
 # time (and retained kernel handle) survives exit; neither proves liveness.
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
