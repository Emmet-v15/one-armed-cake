#Requires -RunAsAdministrator
<#
.SYNOPSIS
Capture Valorant's game traffic on this PC (pktmon) and on the shaper (tcpdump) at once.

.DESCRIPTION
Run from an elevated PowerShell while you are in a match. It stops after -Seconds,
or when you press q, then runs valcap.py on the result.

Each run gets its own folder under -OutDir with:
    pc.pcapng         every UDP packet on this PC's NICs, first 128 bytes
    pi.pcap           Valorant-port UDP on the shaper's eth0, both legs
    pi-tcpdump.txt    tcpdump's own summary, including kernel drops
    ShooterGame.log   copy of Valorant's log, for its input warnings
    report.txt        valcap.py output

NOTE: this clears any pktmon filters you had set (pktmon filter remove).

.EXAMPLE
    .\tools\valcap.ps1                  # 5 minutes
    .\tools\valcap.ps1 -Seconds 600
    .\tools\valcap.ps1 -NoPi            # PC side only
#>
param(
    [int]$Seconds = 300,
    [string]$OutDir = "$env:USERPROFILE\valcap",
    [string]$PiHost = 'homenet',
    [switch]$NoPi
)
# Not 'Stop': in Windows PowerShell 5.1 any stderr from ssh or pktmon would then abort the run.
$ErrorActionPreference = 'Continue'

$run = Join-Path $OutDir (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Force $run | Out-Null
$etl = Join-Path $run 'pc.etl'
$remote = '/tmp/valcap.pcap'
$sshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8')

& pktmon stop 2>&1 | Out-Null
& pktmon filter remove | Out-Null
& pktmon filter add valcap-udp -t UDP | Out-Null

$ssh = $null
if (-not $NoPi) {
    # timeout is a backstop in case this window dies before it can stop tcpdump.
    $cmd = "sudo rm -f $remote; sudo timeout --signal=INT $($Seconds + 30) tcpdump -i eth0 -s 128 -U -w $remote 'udp portrange 7000-8999'"
    $ssh = Start-Process ssh -ArgumentList "-o BatchMode=yes -o ConnectTimeout=8 $PiHost `"$cmd`"" `
        -NoNewWindow -PassThru -RedirectStandardError (Join-Path $run 'pi-tcpdump.txt')
    Start-Sleep -Seconds 2
    if ($ssh.HasExited) { Write-Warning "tcpdump on $PiHost did not start; see pi-tcpdump.txt. Continuing PC-only."; $ssh = $null }
}

& pktmon start --capture --comp nics --pkt-size 128 --file-name $etl | Out-Null
Write-Host "Capturing to $run"
Write-Host "Play normally. Stops in $Seconds s, or press q to stop now."

$game = Get-Process VALORANT-Win64-Shipping -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $game) { Write-Warning "Valorant isn't running; there will be no game traffic to analyse." }
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
    $nextNote = 30
    while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
        if ([Console]::KeyAvailable -and [Console]::ReadKey($true).KeyChar -eq 'q') { break }
        if ($game -and $game.HasExited) { Write-Host "Valorant closed."; break }
        Start-Sleep -Milliseconds 200
        if ($sw.Elapsed.TotalSeconds -ge $nextNote) { Write-Host ("  {0} s" -f $nextNote); $nextNote += 30 }
    }
}
finally {
    Write-Host "Stopping after $([int]$sw.Elapsed.TotalSeconds) s..."
    & pktmon stop | Out-Null
    & pktmon filter remove | Out-Null

    if ($ssh) {
        # eth[0] keeps this pattern from matching the shell that runs pkill.
        & ssh @sshOpts $PiHost "sudo pkill -INT -f 'tcpdump -i eth[0] -s 128'" 2>&1 | Out-Null
        if (-not $ssh.WaitForExit(15000)) { $ssh.Kill() }
        & ssh @sshOpts $PiHost "sudo chmod 644 $remote" 2>&1 | Out-Null
        & scp -q @sshOpts "${PiHost}:$remote" (Join-Path $run 'pi.pcap')
        & ssh @sshOpts $PiHost "sudo rm -f $remote" 2>&1 | Out-Null
    }

    & pktmon etl2pcap $etl --out (Join-Path $run 'pc.pcapng') | Out-Null

    $log = "$env:LOCALAPPDATA\VALORANT\Saved\Logs\ShooterGame.log"
    if (Test-Path $log) { Copy-Item $log (Join-Path $run 'ShooterGame.log') }
}

Write-Host ""
& python (Join-Path $PSScriptRoot 'valcap.py') $run | Tee-Object -FilePath (Join-Path $run 'report.txt')
Write-Host ""
Write-Host "Report saved to $(Join-Path $run 'report.txt')"
