param([ValidatePattern('^[\w.-]+$')][string]$Distro = 'yunzai-llm-sandbox')
$pattern = '\-d\s+' + [regex]::Escape($Distro) + '\s+\-u\s+pc\s+\-e\s+sleep\s+infinity(?:\s|$)'
$existingKeeper = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'wsl.exe' -and $_.CommandLine -match $pattern } | Select-Object -First 1
if ($existingKeeper) {
    Write-Output "Existing RustDesk WSL keepalive PID $($existingKeeper.ProcessId)"
} else {
    $keeper = Start-Process -FilePath "$env:SystemRoot\System32\wsl.exe" -ArgumentList @('-d', $Distro, '-u', 'pc', '-e', 'sleep', 'infinity') -WindowStyle Hidden -PassThru
    Write-Output "Started RustDesk WSL keepalive PID $($keeper.Id)"
}
