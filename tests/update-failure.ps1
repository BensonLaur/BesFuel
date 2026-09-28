$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('besfuel-update-test-' + [guid]::NewGuid().ToString('N'))
function Get-ContentHash([string]$path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($path))) }
    finally { $sha.Dispose() }
}
try {
    New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'scripts'), (Join-Path $fixtureRoot 'data') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'scripts/update-guangdong.ps1') -Destination (Join-Path $fixtureRoot 'scripts/update-guangdong.ps1')
    Copy-Item -LiteralPath (Join-Path $root 'data/prices.json') -Destination (Join-Path $fixtureRoot 'data/prices.json')
    Copy-Item -LiteralPath (Join-Path $root 'data/prices.js') -Destination (Join-Path $fixtureRoot 'data/prices.js')
    $jsonPath = Join-Path $fixtureRoot 'data/prices.json'
    $jsPath = Join-Path $fixtureRoot 'data/prices.js'
    $beforeJson = Get-ContentHash $jsonPath
    $beforeJs = Get-ContentHash $jsPath
    $data = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $latestDate = [DateTime]::ParseExact($data.regions.guangdong.grades.'92'.history[-1].date, 'yyyy-MM-dd', [cultureinfo]::InvariantCulture)
    $published = $latestDate.AddDays(-1)
    $title = '{0}年{1}月{2}日24时起成品油价格调整' -f $published.Year, $published.Month, $published.Day
    $noticeUrl = 'https://drc.gd.gov.cn/ywgg/content/post_9999999.html'
    function Invoke-WebRequest {
        [CmdletBinding()]
        param([string]$Uri, [switch]$UseBasicParsing, [int]$TimeoutSec)
        if ($Uri -like '*index.html') {
            return [pscustomobject]@{ Content = '<a href="' + $noticeUrl + '">' + $title + '</a>' }
        }
        return [pscustomobject]@{ Content = '<meta name="ArticleTitle" content="' + $title + '"><table><tr><td>92号汽油</td><td>1</td><td>1</td><td>8.63</td></tr><tr><td>95号汽油</td><td>1</td><td>1</td><td>9.35</td></tr></table>' }
    }
    $failed = $false
    try { & (Join-Path $fixtureRoot 'scripts/update-guangdong.ps1') -MaxNotices 1 }
    catch {
        if ($_.Exception.Message -notmatch '公告缺少 diesel') { throw }
        $failed = $true
    }
    if (-not $failed) { throw '缺少柴油价格的公告未被拒绝。' }
    if ((Get-ContentHash $jsonPath) -ne $beforeJson -or
        (Get-ContentHash $jsPath) -ne $beforeJs) {
        throw '解析失败后原有快照发生变化。'
    }
    Write-Output 'Malformed official notice rejected; both trusted files stayed byte-identical.'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        $resolved = (Resolve-Path -LiteralPath $fixtureRoot).Path
        $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw '拒绝删除临时目录之外的路径。' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
