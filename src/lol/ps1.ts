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
