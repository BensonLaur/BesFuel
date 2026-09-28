param(
    [int]$MaxNotices = 12
)

$ErrorActionPreference = 'Stop'
$culture = [System.Globalization.CultureInfo]::InvariantCulture
$dataDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'data'
$jsonPath = Join-Path $dataDirectory 'prices.json'
$scriptPath = Join-Path $dataDirectory 'prices.js'
$indexUrl = 'https://drc.gd.gov.cn/ywgg/index.html'
$chinaToday = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).Date

function Get-OfficialHtml([string]$url) {
    if ($url -notmatch '^https://drc\.gd\.gov\.cn/ywgg/(index\.html|content/post_\d+\.html)$') {
        throw "拒绝非广东省发改委公告地址：$url"
    }
    return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop).Content
}

function Get-NoticeLinks([string]$html) {
    $pattern = '(?is)<a\b[^>]*href="(?<url>https://drc\.gd\.gov\.cn/ywgg/content/post_\d+\.html)"[^>]*>(?<title>.*?)</a>'
    $links = foreach ($match in [regex]::Matches($html, $pattern)) {
        $title = [System.Net.WebUtility]::HtmlDecode([regex]::Replace($match.Groups['title'].Value, '<[^>]+>', '')).Trim()
        if ($title -match '^(?<year>\d{4})年(?<month>\d{1,2})月(?<day>\d{1,2})日24时起成品油价格调整$') {
            $published = [DateTime]::new([int]$Matches.year, [int]$Matches.month, [int]$Matches.day)
            $effective = $published.AddDays(1)
            if ($effective -le $chinaToday) {
                [pscustomobject]@{ url = $match.Groups['url'].Value; title = $title; published = $published; effective = $effective }
            }
        }
    }
    return @($links | Sort-Object -Property effective -Descending -Unique | Select-Object -First $MaxNotices)
}

function Get-NoticePrices([string]$html, [string]$expectedTitle) {
    $titleMatch = [regex]::Match($html, '<meta\s+name="ArticleTitle"\s+content="([^"]+)"', 'IgnoreCase')
    if (-not $titleMatch.Success -or [System.Net.WebUtility]::HtmlDecode($titleMatch.Groups[1].Value) -ne $expectedTitle) {
        throw "公告标题与列表不一致：$expectedTitle"
    }
    $prices = @{}
    foreach ($row in [regex]::Matches($html, '(?is)<tr\b[^>]*>(.*?)</tr>')) {
        $cells = @(
            foreach ($cell in [regex]::Matches($row.Groups[1].Value, '(?is)<td\b[^>]*>(.*?)</td>')) {
                $plain = [regex]::Replace($cell.Groups[1].Value, '<[^>]+>', '')
                [regex]::Replace([System.Net.WebUtility]::HtmlDecode($plain), '\s+', '')
            }
        )
        if ($cells.Count -lt 4) { continue }
        $grade = if ($cells[0] -match '^92号汽油') { '92' }
            elseif ($cells[0] -match '^95号汽油') { '95' }
            elseif ($cells[0] -match '^0号柴油') { 'diesel' }
            else { $null }
        if ($null -eq $grade) { continue }
        $priceText = $cells[$cells.Count - 1]
        if ($priceText -notmatch '^\d{1,2}\.\d{2}$') { throw "无法识别 $grade 号油每升价格：$priceText" }
        $price = [double]::Parse($priceText, $culture)
        if ($price -lt 1 -or $price -gt 30) { throw "价格超出校验范围：$price" }
        $prices[$grade] = $price
    }
    foreach ($grade in @('92', '95', 'diesel')) {
        if (-not $prices.ContainsKey($grade)) { throw "公告缺少 $grade 号油价格：$expectedTitle" }
    }
    return $prices
}

function Write-CrlfUtf8([string]$path, [string]$content) {
    $normalized = [regex]::Replace($content.TrimEnd(), '\r\n|\r|\n', "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($path, $normalized, [System.Text.UTF8Encoding]::new($false))
}

if ($MaxNotices -lt 1 -or $MaxNotices -gt 30) { throw 'MaxNotices 必须在 1 到 30 之间。' }
$data = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$region = $data.regions.guangdong
if ($null -eq $region) { throw 'prices.json 缺少 guangdong 地区。' }
$links = @(Get-NoticeLinks (Get-OfficialHtml $indexUrl))
if (-not $links.Count) { throw '官网公告列表没有可识别的已生效调价通知，数据保持不变。' }

# Parse every selected notice before writing either output file.
$notices = foreach ($link in $links) {
    $html = Get-OfficialHtml $link.url
    [pscustomobject]@{
        url = $link.url
        published = $link.published
        effective = $link.effective
        prices = Get-NoticePrices $html $link.title
    }
}
$latest = $notices | Sort-Object -Property effective -Descending | Select-Object -First 1
$previousLatest = @($region.grades.'92'.history | Sort-Object -Property date | Select-Object -Last 1)[0]
if ($null -eq $previousLatest -or $latest.effective.ToString('yyyy-MM-dd', $culture) -lt $previousLatest.date) {
    throw '官网列表的最新公告早于现有快照，拒绝回退价格。'
}
if ($latest.effective.ToString('yyyy-MM-dd', $culture) -eq $previousLatest.date) {
    foreach ($grade in @('92', '95', 'diesel')) {
        $existing = @($region.grades.PSObject.Properties[$grade].Value.history | Sort-Object -Property date | Select-Object -Last 1)[0]
        if ($existing.date -ne $previousLatest.date -or $existing.price -ne $latest.prices[$grade] -or $existing.sourceUrl -ne $latest.url) {
            throw '官网最新公告与现有同日快照冲突，需要人工核对。'
        }
    }
}
foreach ($grade in @('92', '95', 'diesel')) {
    $entry = $region.grades.PSObject.Properties[$grade].Value
    $historyByDate = @{}
    foreach ($point in @($entry.history)) {
        if ($null -ne $point -and $point.date) { $historyByDate[$point.date] = $point }
    }
    foreach ($notice in $notices) {
        $date = $notice.effective.ToString('yyyy-MM-dd', $culture)
        $historyByDate[$date] = [pscustomobject]@{ date = $date; price = $notice.prices[$grade]; sourceUrl = $notice.url }
    }
    $entry.history = @($historyByDate.Values | Sort-Object -Property date)
    $entry.price = $latest.prices[$grade]
}
$region.source.url = $latest.url
$region.effectiveLabel = $latest.published.ToString('yyyy-MM-dd', $culture) + ' 24:00 起'
$region.checkedAt = $chinaToday.ToString('yyyy-MM-dd', $culture)
$data.checkedAt = $region.checkedAt

$jsonText = $data | ConvertTo-Json -Depth 30
$jsText = "// Generated from data/prices.json by scripts/update-guangdong.ps1.`nwindow.BESFUEL_DATA = $jsonText;"
$jsonTemporary = Join-Path $dataDirectory '.prices.json.tmp'
$jsTemporary = Join-Path $dataDirectory '.prices.js.tmp'
try {
    Write-CrlfUtf8 $jsonTemporary $jsonText
    Write-CrlfUtf8 $jsTemporary $jsText
    & node (Join-Path $PSScriptRoot 'validate-data.cjs') $jsonTemporary $jsTemporary
    if ($LASTEXITCODE -ne 0) { throw '新快照验证失败，现有数据保持不变。' }
    Move-Item -LiteralPath $jsonTemporary -Destination $jsonPath -Force
    Move-Item -LiteralPath $jsTemporary -Destination $scriptPath -Force
} finally {
    foreach ($temporary in @($jsonTemporary, $jsTemporary)) {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
Write-Output ("广东价格已核对：" + $region.checkedAt + "，最新执行 " + $region.effectiveLabel + "；92=" + $region.grades.'92'.price + "，95=" + $region.grades.'95'.price + "，0号柴油=" + $region.grades.diesel.price + "；历史公告 " + $notices.Count + " 条。")
