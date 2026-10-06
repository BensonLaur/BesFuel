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

    # Exercise forecast updates with official and market responses controlled locally.
    # Keep the real snapshot formatter and validator so both published files are checked.
    $nodeExecutable = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $marketWindow = '2026-10-15'
    $data.nationalAdjustment.nextAdjustment.date = $marketWindow
    $data.nationalAdjustment.nextAdjustment.dateLabel = "预计 $marketWindow 24:00"
    $data.nationalAdjustment.forecast = [pscustomobject]@{
        direction = 'down'; amountPerLiter = 0.16; description = '预计下调约 0.16 元/升'
        sourceName = '团友网'; sourceUrl = 'https://www.tuanyou.net/yuanyou/bianhualv/815.html'
        updatedAt = '2026-09-29'; windowDate = $marketWindow; workday = 2
    }
    [System.IO.File]::WriteAllText($jsonPath, ($data | ConvertTo-Json -Depth 30), [System.Text.UTF8Encoding]::new($false))
    & $nodeExecutable (Join-Path $root 'scripts/format-snapshot.cjs') $jsonPath $jsPath
    if ($LASTEXITCODE -ne 0) { throw 'Fixture formatting failed.' }
    $noticeUrl = $data.regions.guangdong.source.url
    $noticeHtml = '<meta name="ArticleTitle" content="' + $title + '"><table>'
    foreach ($grade in @('92', '95', 'diesel')) {
        $label = if ($grade -eq 'diesel') { '0号柴油' } else { $grade + '号汽油' }
        $price = $data.regions.guangdong.grades.$grade.price.ToString('F2', [cultureinfo]::InvariantCulture)
        $noticeHtml += '<tr><td>' + $label + '</td><td>1</td><td>1</td><td>' + $price + '</td></tr>'
    }
    $noticeHtml += '</table>'
    function Invoke-WebRequest {
        [CmdletBinding()]
        param([string]$Uri, [switch]$UseBasicParsing, [int]$TimeoutSec)
        if ($Uri -like '*index.html') {
            return [pscustomobject]@{ Content = '<a href="' + $noticeUrl + '">' + $title + '</a>' }
        }
        return [pscustomobject]@{ Content = $noticeHtml }
    }
    function node {
        param([string]$ScriptPath, [string]$First, [string]$Second)
        $global:LASTEXITCODE = 0
        switch (Split-Path -Leaf $ScriptPath) {
            'next-window.cjs' { return $marketWindow }
            'read-market-forecast.cjs' { return $marketResponse }
            'format-snapshot.cjs' { & $nodeExecutable (Join-Path $root 'scripts/format-snapshot.cjs') $First $Second }
            'validate-data.cjs' { & $nodeExecutable (Join-Path $root 'scripts/validate-data.cjs') $First $Second }
            default { throw "Unexpected script: $ScriptPath" }
        }
    }
    $candidate = $data.nationalAdjustment.forecast | ConvertTo-Json | ConvertFrom-Json
    $candidate.updatedAt = '2026-09-30'
    $candidate.workday = 3
    $candidate.amountPerLiter = 0.19
    $candidate.description = '预计下调约 0.19 元/升'
    $candidate.direction = 'down'
    $candidate.sourceUrl = 'https://www.tuanyou.net/yuanyou/bianhualv/816.html'
    $marketResponse = @{ forecast = $candidate } | ConvertTo-Json -Depth 10 -Compress
    & (Join-Path $fixtureRoot 'scripts/update-guangdong.ps1') -MaxNotices 1
    $accepted = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($accepted.nationalAdjustment.forecast.updatedAt -ne '2026-09-30' -or
        $accepted.nationalAdjustment.forecast.amountPerLiter -ne 0.19) {
        throw '本轮已核实的旧估算未被收录，或计算日期被刷新。'
    }
    $acceptedForecast = $accepted.nationalAdjustment.forecast | ConvertTo-Json -Compress
    foreach ($response in @(
        (@{ forecast = $data.nationalAdjustment.forecast } | ConvertTo-Json -Depth 10 -Compress),
        '{"error":"forecast source unavailable"}'
    )) {
        $marketResponse = $response
        & (Join-Path $fixtureRoot 'scripts/update-guangdong.ps1') -MaxNotices 1
        $retained = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (($retained.nationalAdjustment.forecast | ConvertTo-Json -Compress) -ne $acceptedForecast) {
            throw '来源回退或读取失败时，未保留已有的本轮可信估算。'
        }
    }
    $marketWindow = '2026-10-29'
    & (Join-Path $fixtureRoot 'scripts/update-guangdong.ps1') -MaxNotices 1
    $newCycle = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($newCycle.nationalAdjustment.forecast.description -or $newCycle.nationalAdjustment.forecast.updatedAt) {
        throw '进入新周期后仍保留上一轮预测。'
    }
    Write-Output 'Forecast updates passed: dated reference accepted, rollback and failure retained, new cycle cleared.'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        $resolved = (Resolve-Path -LiteralPath $fixtureRoot).Path
        $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw '拒绝删除临时目录之外的路径。' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
