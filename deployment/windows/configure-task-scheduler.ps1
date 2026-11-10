param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$existing = Get-RishNovaTask
$existingShutdown = Get-RishNovaShutdownTask
if ($Uninstall) {
    foreach ($task in @($existing, $existingShutdown)) {
        if ($task) {
            Assert-RishNovaTaskOwned -Task $task
            Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false
        }
    }
    Write-Output 'Removed the RishNova startup and shutdown tasks.'
    exit 0
}

if ($existing) {
    Assert-RishNovaTaskOwned -Task $existing
}
if ($existingShutdown) {
    Assert-RishNovaTaskOwned -Task $existingShutdown
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershell = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $PSScriptRoot 'startup.ps1')
$action = New-ScheduledTaskAction `
    -Execute $powershell `
    -Argument $arguments `
    -WorkingDirectory $script:RishNovaRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $script:RishNovaTaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description $script:RishNovaTaskMarker `
    -Force | Out-Null

$shutdownCommand = [System.Security.SecurityElement]::Escape($powershell)
$shutdownWorkingDirectory = [System.Security.SecurityElement]::Escape($script:RishNovaRoot)
$shutdownArguments = [System.Security.SecurityElement]::Escape(
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $PSScriptRoot 'shutdown.ps1')
)
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$subscription = '&lt;QueryList&gt;&lt;Query Id="0" Path="System"&gt;&lt;Select Path="System"&gt;*[System[Provider[@Name=''User32''] and EventID=1074]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;'
$shutdownTaskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$($script:RishNovaTaskMarker)</Description></RegistrationInfo>
  <Triggers><EventTrigger><Enabled>true</Enabled><Subscription>$subscription</Subscription></EventTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$userSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
  </Settings>
  <Actions Context="Author"><Exec><Command>$shutdownCommand</Command><Arguments>$shutdownArguments</Arguments><WorkingDirectory>$shutdownWorkingDirectory</WorkingDirectory></Exec></Actions>
</Task>
"@
$parsedShutdownTask = [xml]$shutdownTaskXml
Register-ScheduledTask `
    -TaskName $script:RishNovaShutdownTaskName `
    -Xml $shutdownTaskXml `
    -Force | Out-Null

Write-Output "Registered the RishNova server at sign-in and shutdown hook for $user."
