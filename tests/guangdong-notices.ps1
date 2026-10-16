$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('besfuel-notice-test-' + [guid]::NewGuid().ToString('N'))
$nodeExecutable = (Get-Command node -CommandType Application | Select-Object -First 1).Source

function New-PricePage([string]$title, [double]$increase = 0) {
    $html = '<meta name="ArticleTitle" content="' + $title + '"><table>'
    foreach ($grade in @('92', '95', 'diesel')) {
        $label = if ($grade -eq 'diesel') { '0号柴油' } else { $grade + '号汽油' }
        $price = ($basePrices[$grade] + $increase).ToString('F2', [cultureinfo]::InvariantCulture)
        $html += '<tr><td>' + $label + '</td><td>1</td><td>1</td><td>' + $price + '</td></tr>'
    }
    return $html + '</table>'
}

function New-UnchangedPage([string]$title, [string]$dateText, [string]$wording = '不作调整') {
    return '<meta name="ArticleTitle" content="' + $title + '"><div id="content1"><p>本次汽、柴油价格' +
        $wording + '。</p><p>广东省发展改革委</p><p>' + $dateText + '</p><div class="fjlis"></div></div>'
}

function Invoke-WebRequest {
    [CmdletBinding()]
    param([string]$Uri, [switch]$UseBasicParsing, [int]$TimeoutSec)
    if ($Uri -eq 'https://drc.gd.gov.cn/ywgg/index.html') { return [pscustomobject]@{ Content = $indexHtml } }
    if (-not $pages.ContainsKey($Uri)) { throw "Unexpected official request: $Uri" }
    return [pscustomobject]@{ Content = $pages[$Uri] }
}

function node {
    param([string]$ScriptPath, [string]$First, [string]$Second)
    $global:LASTEXITCODE = 0
    switch (Split-Path -Leaf $ScriptPath) {
        'next-window.cjs' { $captured.windowAnchor = $First; return '' }
        'read-market-forecast.cjs' { throw 'No forecast should be fetched without a supported window.' }
        'format-snapshot.cjs' { & $nodeExecutable (Join-Path $root 'scripts/format-snapshot.cjs') $First $Second }
        'validate-data.cjs' { & $nodeExecutable (Join-Path $root 'scripts/validate-data.cjs') $First $Second }
        default { throw "Unexpected script: $ScriptPath" }
    }
}

function Read-Fixture { return Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json }
function Update-Fixture { & (Join-Path $fixtureRoot 'scripts/update-guangdong.ps1') -MaxNotices 1 }
function Fixture-Hashes {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (@($jsonPath, $jsPath) | ForEach-Object {
            [BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($_)))
        }) -join ':'
    } finally { $sha.Dispose() }
}
function Assert-Rejected([string]$expected) {
    $before = Fixture-Hashes
    $failed = $false
    try { Update-Fixture }
    catch {
        if ($_.Exception.Message -notmatch $expected) { throw }
        $failed = $true
    }
    if (-not $failed) { throw "Expected notice rejection: $expected" }
    if ((Fixture-Hashes) -ne $before) { throw 'Rejected announcement changed a trusted output file.' }
}

try {
    New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'scripts'), (Join-Path $fixtureRoot 'data') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'scripts/update-guangdong.ps1') -Destination (Join-Path $fixtureRoot 'scripts/update-guangdong.ps1')
    $jsonPath = Join-Path $fixtureRoot 'data/prices.json'
    $jsPath = Join-Path $fixtureRoot 'data/prices.js'
    $fixture = Get-Content -LiteralPath (Join-Path $root 'data/prices.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $region = $fixture.regions.guangdong
    $region.PSObject.Properties.Remove('latestNotice')
    # Historical fixture dates stay in the past and do not depend on the live adjustment cycle.
    $basePrices = @{ '92' = 8.63; '95' = 9.35; 'diesel' = 8.31 }
    $baseUrl = 'https://drc.gd.gov.cn/ywgg/content/post_9000000.html'
    $baseTitle = '2020年1月1日24时起成品油价格调整'
    $region.source.url = $baseUrl
    $region.effectiveLabel = '2020-01-01 24:00 起'
    foreach ($grade in @('92', '95', 'diesel')) {
        $region.grades.$grade.price = $basePrices[$grade]
        $region.grades.$grade.history = @([pscustomobject]@{ date = '2020-01-02'; price = $basePrices[$grade]; sourceUrl = $baseUrl })
    }
    [System.IO.File]::WriteAllText($jsonPath, ($fixture | ConvertTo-Json -Depth 30), [System.Text.UTF8Encoding]::new($false))
    & $nodeExecutable (Join-Path $root 'scripts/format-snapshot.cjs') $jsonPath $jsPath
    if ($LASTEXITCODE -ne 0) { throw 'Notice fixture formatting failed.' }
    $originalPrices = $region.grades | ConvertTo-Json -Depth 10 -Compress
    $pages = @{ $baseUrl = (New-PricePage $baseTitle) }
    $captured = @{}
    $indexHtml = '<a href="' + $baseUrl + '">' + $baseTitle + '</a>'
    foreach ($day in @('15', '29')) {
        $title = '2020年1月' + $day + '日成品油价格不作调整'
        $url = 'https://drc.gd.gov.cn/ywgg/content/post_90000' + $day + '.html'
        $pages[$url] = New-UnchangedPage $title ('2020年1月' + $day + '日')
        $indexHtml = '<a href="' + $url + '">' + $title + '</a>' + $indexHtml
        Update-Fixture
        $result = Read-Fixture
        $region = $result.regions.guangdong
        if (($region.grades | ConvertTo-Json -Depth 10 -Compress) -ne $originalPrices -or
            $region.effectiveLabel -ne '2020-01-01 24:00 起' -or $region.source.url -ne $baseUrl) {
            throw 'An unchanged announcement modified price data or its effective date/source.'
        }
        if ($region.latestNotice.kind -ne 'unchanged' -or $region.latestNotice.sourceUrl -ne $url -or
            $region.latestNotice.date -ne ('2020-01-' + $day) -or $captured.windowAnchor -ne ('2020-01-' + $day)) {
            throw 'Latest unchanged announcement or next-window anchor was not updated.'
        }
    }
    $before = Fixture-Hashes
    $indexHtml += '<a href="' + $url + '">' + $title + '</a>'
    Update-Fixture
    if ((Fixture-Hashes) -ne $before) { throw 'Repeated unchanged announcement was not idempotent.' }

    $adjustedUrl = 'https://drc.gd.gov.cn/ywgg/content/post_9000030.html'
    $adjustedTitle = '2020年2月12日24时起成品油价格调整'
    $pages[$adjustedUrl] = New-PricePage $adjustedTitle 0.10
    $indexHtml = '<a href="' + $adjustedUrl + '">' + $adjustedTitle + '</a>' + $indexHtml
    Update-Fixture
    $region = (Read-Fixture).regions.guangdong
    foreach ($grade in @('92', '95', 'diesel')) {
        if ($region.grades.$grade.history.Count -ne 2 -or
            [math]::Abs($region.grades.$grade.price - ($basePrices[$grade] + 0.10)) -gt 0.00001) {
            throw 'A later adjustment did not resume normal price updates.'
        }
    }
    if ($region.latestNotice.kind -ne 'adjusted' -or $region.effectiveLabel -ne '2020-02-12 24:00 起') {
        throw 'Adjusted announcement left an obsolete unchanged status.'
    }
    $validIndex = $indexHtml
    $badUrl = 'https://drc.gd.gov.cn/ywgg/content/post_9000031.html'
    $badTitle = '2020年2月26日成品油价格不作调整'
    $indexHtml = '<a href="' + $badUrl + '">' + $badTitle + '</a>' + $validIndex
    foreach ($badPage in @(
        (New-UnchangedPage '标题与列表不一致' '2020年2月26日'),
        (New-UnchangedPage $badTitle '2020年2月25日'),
        (New-UnchangedPage $badTitle '2020年2月26日' '待核实'),
        ((New-UnchangedPage $badTitle '2020年2月26日') -replace '本次汽、柴油价格', '仅供参考的汽、柴油价格'),
        ((New-UnchangedPage $badTitle '2020年2月26日') -replace '</p><p>广东', '本次汽油价格上调。</p><p>广东')
    )) {
        $pages[$badUrl] = $badPage
        Assert-Rejected '公告标题与列表不一致|不调整公告正文未通过核实'
    }
    foreach ($wording in @('不做调整', '不调整', '暂不调整')) {
        $variant = '2020年2月26日成品油价格' + $wording
        $indexHtml = '<a href="' + $badUrl + '">' + $variant + '</a>' + $validIndex
        $pages[$badUrl] = New-UnchangedPage $variant '2020年2月26日' $wording
        Update-Fixture
    }
    $verifiedIndex = $indexHtml
    $before = Fixture-Hashes
    $indexHtml = '<a href="https://drc.gd.gov.cn/ywgg/content/post_9000098.html">2099年1月1日24时起成品油价格调整</a>' +
        '<a href="https://drc.gd.gov.cn/ywgg/content/post_9000099.html">2099年1月2日成品油价格不作调整</a>' + $verifiedIndex
    Update-Fixture
    if ((Fixture-Hashes) -ne $before) { throw 'A future announcement changed the current verified result.' }
    $indexHtml = $verifiedIndex
    $pages[$adjustedUrl] = New-PricePage $adjustedTitle 0.20
    Assert-Rejected '现有同日快照冲突'
    $pages[$adjustedUrl] = New-PricePage $adjustedTitle 0.10
    $indexHtml = $validIndex
    Assert-Rejected '最近公告回退'
    $indexHtml = '<a href="https://example.com/post_1.html">' + $badTitle + '</a>' + $validIndex
    Assert-Rejected '非官方成品油公告链接'
    $indexHtml = '<a href="' + $badUrl + '">2020年2月26日成品油价格另行通知</a>' + $validIndex
    Assert-Rejected '无法识别成品油公告类型'
    $indexHtml = '<a href="' + $badUrl + '">' + $badTitle + '</a>' +
        '<a href="' + $adjustedUrl + '">2020年2月26日24时起成品油价格调整</a>' + $validIndex
    Assert-Rejected '同日公告存在冲突'
    $indexHtml = '<a href="' + $badUrl + '">' + $badTitle + '</a>'
    Assert-Rejected '缺少可核实的已生效价格表'
    Write-Output 'Notice updates passed: consecutive unchanged cycles, price recovery, deduplication, variants, rollback, and atomic rejection of unverified announcements.'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        $resolved = (Resolve-Path -LiteralPath $fixtureRoot).Path
        $tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw '拒绝删除临时目录之外的路径。' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
