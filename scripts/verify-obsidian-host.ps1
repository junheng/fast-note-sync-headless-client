param([Parameter(Mandatory=$true)][int]$ExpectedProcessId)
$ErrorActionPreference = "Stop"
# Only the explicitly started acceptance process may receive this request.
$listeners = @(Get-NetTCPConnection -LocalPort 19227 -State Listen)
if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $ExpectedProcessId -or $listeners[0].LocalAddress -ne "127.0.0.1") { throw "Unexpected debug listener" }
$targets = @((Invoke-RestMethod http://127.0.0.1:19227/json/list) | Where-Object { $_.type -eq "page" })
if ($targets.Count -ne 1) { throw "Unexpected page count" }
$root = Join-Path $env:LOCALAPPDATA "fns-headless-acceptance"
$vaultJson = ConvertTo-Json -Compress (Join-Path $root "vault")
$profileJson = ConvertTo-Json -Compress (Join-Path $root "profile")
$expression = @"
(async()=>{
 const vaultMatches=typeof app!=='undefined' && app.vault.adapter.getBasePath()===$vaultJson;
 const dataDirMatches=require('@electron/remote').app.getPath('userData')===$profileJson;
 if(!vaultMatches || !dataDirMatches) return {ok:false,code:'host-isolation-mismatch'};
 await app.plugins.setEnable(true);
 const p=app.plugins.plugins['fast-note-sync'];
 return {ok:!!p,pluginLoaded:!!p,pluginVersion:p?.manifest.version??null,vaultMatches,dataDirMatches,syncEnabled:p?.settings.syncEnabled??null};
})()
"@
$client = New-Object System.Net.WebSockets.ClientWebSocket
$cancel = New-Object System.Threading.CancellationTokenSource
$cancel.CancelAfter(15000)
try {
  [void]$client.ConnectAsync([Uri]($targets[0].webSocketDebuggerUrl),$cancel.Token).GetAwaiter().GetResult()
  $request = @{id=1;method="Runtime.evaluate";params=@{expression=$expression;awaitPromise=$true;returnByValue=$true}} | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($request)
  [void]$client.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,$cancel.Token).GetAwaiter().GetResult()
  do {
    $stream = New-Object System.IO.MemoryStream
    try {
      do {
        $buffer = New-Object byte[] 8192
        $chunk = $client.ReceiveAsync([ArraySegment[byte]]::new($buffer),$cancel.Token).GetAwaiter().GetResult()
        $stream.Write($buffer,0,$chunk.Count)
        if ($stream.Length -gt 1048576) { throw "Response too large" }
      } while (!$chunk.EndOfMessage)
      $reply = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
    } finally { $stream.Dispose() }
  } while ($reply.id -ne 1)
  if ($reply.error -or $reply.result.exceptionDetails) { throw "Host probe failed" }
  $value = $reply.result.result.value
  if (!$value.ok -or !$value.vaultMatches -or !$value.dataDirMatches -or $value.syncEnabled) { throw "Host verification failed" }
  $value | ConvertTo-Json -Compress
} finally { $client.Dispose(); $cancel.Dispose() }
