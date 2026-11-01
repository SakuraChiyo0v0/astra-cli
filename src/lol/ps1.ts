/**
 * 在用户 PC 上跑的 PowerShell：读 LCU 端口/令牌，抓三份 JSON 落到本地目录。
 *
 * 为什么是 PowerShell + curl.exe：
 * - LCU 是 HTTPS 自签证书，PowerShell 5.1 的 `Invoke-RestMethod` 在这里会
 *   「远程主机已关闭/连接超时」，而 `curl.exe -k` 一次就 200（实测）。
 * - 端口和令牌只在 `LeagueClientUx.exe` 的命令行里（`--app-port` / `--remoting-auth-token`），
 *   客户端重启就变，所以每次现读，不能缓存。
 *
 * 这个脚本会被 `astra lol sync` 用 scp 送到 PC 再执行；PC 上不需要装任何东西。
 */
export const LCU_DUMP_PS1 = String.raw`$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$ux = Get-CimInstance Win32_Process -Filter "Name = 'LeagueClientUx.exe'"
if (-not $ux) { Write-Output "NO_CLIENT"; exit 2 }
$cmd = $ux.CommandLine
$port = ([regex]::Match($cmd, '--app-port=(\d+)')).Groups[1].Value
$token = ([regex]::Match($cmd, '--remoting-auth-token=([\w\-]+)')).Groups[1].Value
if (-not $port -or -not $token) { Write-Output "NO_CREDENTIALS"; exit 2 }

$outDir = $env:ASTRA_LOL_DUMP_DIR
if (-not $outDir) { $outDir = 'C:\LocalSpace\lol-dump' }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$base = "https://127.0.0.1:$port"

function Fetch($path, $file) {
  $out = Join-Path $outDir $file
  $code = & curl.exe -k -s --noproxy "*" -m 30 -o $out -w "%{http_code}" -u "riot:$token" "$base$path"
  Write-Output ("FETCH {0} -> {1}" -f $path, $code)
  return $code
}

$meFile = 'summoner.json'
Fetch '/lol-summoner/v1/current-summoner' $meFile | Out-Null
$rankedFile = 'ranked.json'
Fetch '/lol-ranked/v1/current-ranked-stats' $rankedFile | Out-Null
$mhFile = 'matches.json'
Fetch '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=20' $mhFile | Out-Null

foreach ($f in @($meFile, $rankedFile, $mhFile)) {
  $p = Join-Path $outDir $f
  if (Test-Path $p) { Write-Output ("FILE {0} {1} bytes" -f $f, (Get-Item $p).Length) } else { Write-Output ("MISSING " + $f) }
}
`

/**
 * 查「别人」：`名字#TAG` → puuid → 最近对局。
 *
 * 为什么参数走 JSON 文件而不是命令行：中文昵称经 ssh → PowerShell 会按 ANSI 解码，
 * `灬七弑灬` 这类名字必然乱码。把 {"name": "...", "count": N} 写成 UTF-8 文件再 scp 过去，
 * 脚本用 `ReadAllText(..., UTF8)` 读，绕开整条编码链。
 *
 * 实测：`?name=` 只给名字 → 422 INVALID_EMPTY_REQUEST；必须 `名字#TAG`。
 * 对方隐藏战绩时接口仍 200，但 `gameCount > 0` 而 `games` 为空 —— 这是「不给看」，不是「没打过」。
 */
export const LCU_SGP_PLAYER_PS1 = String.raw`$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$ux = Get-CimInstance Win32_Process -Filter "Name = 'LeagueClientUx.exe'"
if (-not $ux) { Write-Output "NO_CLIENT"; exit 2 }
$cmd = $ux.CommandLine
$port = ([regex]::Match($cmd, '--app-port=(\d+)')).Groups[1].Value
$tok = ([regex]::Match($cmd, '--remoting-auth-token=([\w\-]+)')).Groups[1].Value
if (-not $port -or -not $tok) { Write-Output "NO_CREDENTIALS"; exit 2 }

$outDir = $env:ASTRA_LOL_DUMP_DIR
if (-not $outDir) { $outDir = 'C:\LocalSpace\lol-dump' }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$base = "https" + "://" + "127.0.0.1:" + $port
$cred = "riot:" + $tok

$req = [System.IO.File]::ReadAllText((Join-Path $outDir 'player_req.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$name = [string]$req.name
$count = [int]$req.count
if ($count -le 0) { $count = 20 }

$sFile = Join-Path $outDir 'player_summoner.json'
$code = & curl.exe -k -s -G --noproxy "*" -m 25 -o $sFile -w "%{http_code}" --user $cred --data-urlencode ("name=" + $name) ($base + '/lol-summoner/v1/summoners')
Write-Output ("LOOKUP http=" + $code)
if ($code -ne "200") { Write-Output ("LOOKUP_FAIL " + [System.IO.File]::ReadAllText($sFile, [System.Text.Encoding]::UTF8)); exit 0 }
$summoner = [System.IO.File]::ReadAllText($sFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not $summoner.puuid) { Write-Output "LOOKUP_NO_PUUID"; exit 0 }

$regFile = Join-Path $outDir 'player_region.json'
& curl.exe -k -s --noproxy "*" -m 15 -o $regFile --user $cred ($base + '/riotclient/region-locale') | Out-Null
$region = 'TENCENT'
if (Test-Path $regFile) {
  $r = [System.IO.File]::ReadAllText($regFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($r.region) { $region = $r.region }
}
$rso = ''
$flag = @($cmd.Split(' ') | ForEach-Object { $_.Trim([char]34) } | Where-Object { $_ -like '--rso*platform*id=*' })[0]
if ($flag) { $rso = ($flag -split '=', 2)[1].Trim([char]34) }
if (-not $rso) { $rso = '' }
Write-Output ("rsoPlatformId=" + $rso)
$entFile = Join-Path $outDir 'player_ent.json'
& curl.exe -k -s --noproxy "*" -m 15 -o $entFile --user $cred ($base + '/entitlements/v1/token') | Out-Null
$ent = [System.IO.File]::ReadAllText($entFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$jwt = [string]$ent.accessToken
if (-not $jwt) { Write-Output "NO_ACCESS_TOKEN"; exit 0 }

$hostMap = @{
  'HN1' = 'hn1-k8s-sgp'; 'HN10' = 'hn10-k8s-sgp'
  'TJ100' = 'tj100'; 'TJ101' = 'tj101'
  'NJ100' = 'nj100'; 'GZ100' = 'gz100'
}
$sub = if ($rso -and $hostMap.ContainsKey($rso)) { $hostMap[$rso] } elseif ($hostMap.ContainsKey($region)) { $hostMap[$region] } else { (($rso, $region) | Where-Object { $_ } | Select-Object -First 1).ToLower() + '-k8s-sgp' }
$sgp = "https" + "://" + $sub + ".lol.qq.com" + ":21019"
Write-Output ("SGP host=" + $sgp + " region=" + $region + " rso=" + $rso)

$hdrJwt = "Authorization: Bearer " + $jwt

$listFile = Join-Path $outDir 'player_sgp_list.json'
$lc = & curl.exe -k -s --noproxy "*" -m 30 -o $listFile -w "%{http_code}" -H $hdrJwt ($sgp + '/match-history-query/v1/products/lol/player/' + $summoner.puuid + '/SUMMARY?startIndex=0&count=' + $count)
Write-Output ("SGP_LIST http=" + $lc)
if ($lc -ne "200") { Write-Output "SGP_LIST_FAIL"; exit 0 }

$list = [System.IO.File]::ReadAllText($listFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$ids = @($list.games | ForEach-Object { $_.metadata.match_id } | Where-Object { $_ })
Write-Output ("SGP_IDS count=" + $ids.Count)

$collected = @()
$miss = 0
foreach ($gid in $ids) {
  $f = Join-Path $outDir ('sgp_game_' + ($gid -replace '[^0-9]', '') + '.json')
  $gc = & curl.exe -k -s --noproxy "*" -m 30 -o $f -w "%{http_code}" -H $hdrJwt ($sgp + '/match-history-query/v1/products/lol/' + $gid + '/SUMMARY')
  if ($gc -eq "200") {
    $body = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
    $obj = $body | ConvertFrom-Json
    $collected += $obj
    Remove-Item $f -Force -ErrorAction SilentlyContinue
  } else {
    $miss++
    Remove-Item $f -Force -ErrorAction SilentlyContinue
  }
}
Write-Output ("SGP_GAMES collected=" + $collected.Count + " missing=" + $miss)

$wrap = [pscustomobject]@{ puuid = $summoner.puuid; region = $region; games = $collected }
[System.IO.File]::WriteAllText((Join-Path $outDir 'player_sgp.json'), ($wrap | ConvertTo-Json -Depth 40 -Compress), [System.Text.UTF8Encoding]::new($false))
Write-Output "SGP_DONE"
`
