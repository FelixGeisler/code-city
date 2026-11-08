# Shared fail-closed record validation. Loading/compilation performs no GUI action.
function Assert-NativeDesktopIsolation([int]$TargetPid=0) {
 if(-not ('NativeDesktopIsolation' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'native-desktop-isolation.cs') }
 $recordPath=$env:CODE_CITY_NATIVE_ISOLATION_FILE
 if(-not $recordPath){throw 'Owned non-input desktop record required'}
 $item=Get-Item -LiteralPath $recordPath -Force
 $directory=Get-Item -LiteralPath $item.DirectoryName -Force
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Isolation record is not an ordinary owned file'}
 $record=Get-Content -LiteralPath $recordPath -Raw|ConvertFrom-Json
 if($record.schema -ne 1 -or $record.nonce -notmatch '^[a-f0-9]{32}$' -or $record.desktop -cne ('CodeCityNative-'+$record.nonce) -or $record.job -cne ('Local\CodeCityNative-'+$record.nonce)){throw 'Isolation record nonce mismatch'}
 $expected=Join-Path ([IO.Path]::GetTempPath()) ('code-city-desktop-'+$record.nonce)
 if($directory.FullName -cne $expected.TrimEnd('\') -or $item.Name -cne 'ownership.json'){throw 'Isolation record outside owned Temp boundary'}
 [NativeDesktopIsolation]::Configure($record.desktop,$record.job,[int]$record.ownerPid,[long]$record.ownerTicks,$record.ownerExecutable)
 if($record.child.lpDesktop -cne ('WinSta0\'+$record.desktop)){throw 'Isolated Node lpDesktop mismatch'}
 [NativeDesktopIsolation]::GuardLaunchNode([int]$record.child.pid,[long]$record.child.creationTicks,$record.child.executable)
 $node=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$record.child.pid)
 if($node.ParentProcessId -ne [int]$record.ownerPid){throw 'Isolated Node parent mismatch'}
 if($TargetPid){[NativeDesktopIsolation]::GuardProcess($TargetPid)}
 return $record
}
