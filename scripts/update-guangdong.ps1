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
    $pattern = '(?is)<a\b[^>]*href="(?<url>[^"]+)"[^>]*>(?<title>.*?)</a>'
    $links = foreach ($match in [regex]::Matches($html, $pattern)) {
        $title = [System.Net.WebUtility]::HtmlDecode([regex]::Replace($match.Groups['title'].Value, '<[^>]+>', '')).Trim()
        if ($title -match '^(?<year>\d{4})年(?<month>\d{1,2})月(?<day>\d{1,2})日(?<time>24时起)?成品油价格(?<action>调整|不[作做]调整|不调整|暂不调整)$') {
            $kind = if ($Matches.action -eq '调整') { 'adjusted' } else { 'unchanged' }
            if ($kind -eq 'adjusted' -and -not $Matches.time) { throw "无法识别调价执行时间：$title" }
            $published = [DateTime]::new([int]$Matches.year, [int]$Matches.month, [int]$Matches.day)
            if ($match.Groups['url'].Value -notmatch '^https://drc\.gd\.gov\.cn/ywgg/content/post_\d+\.html$') {
                throw "拒绝非官方成品油公告链接：$title"
            }
            $effective = if ($kind -eq 'adjusted') { $published.AddDays(1) } else { $published }
            if ($effective -le $chinaToday) {
                [pscustomobject]@{ url = $match.Groups['url'].Value; title = $title; kind = $kind; published = $published; effective = $effective }
            }
        } elseif ($title -match '^\d{4}年\d{1,2}月\d{1,2}日.*成品油价格') {
            throw "无法识别成品油公告类型，需人工核实：$title"
        }
    }
    foreach ($group in @($links | Group-Object -Property published)) {
        if (@($group.Group | ForEach-Object { $_.kind + '|' + $_.url } | Select-Object -Unique).Count -gt 1) {
            throw '官网同日公告存在冲突，需人工核实。'
        }
    }
    $ordered = @($links | Sort-Object -Property published -Descending -Unique)
    # Unchanged announcements must not crowd the price table they refer to out of the selection.
    $priceLinks = @($ordered | Where-Object { $_.kind -eq 'adjusted' } | Select-Object -First $MaxNotices)
    if (-not $priceLinks.Count) { throw '官网列表缺少可核实的已生效价格表，保留此前可信快照。' }
    return @($ordered | Where-Object { $_.published -ge $priceLinks[-1].published })
}

function Assert-NoticeTitle([string]$html, [string]$expectedTitle) {
    $titleMatch = [regex]::Match($html, '<meta\s+name="ArticleTitle"\s+content="([^"]+)"', 'IgnoreCase')
    if (-not $titleMatch.Success -or [System.Net.WebUtility]::HtmlDecode($titleMatch.Groups[1].Value) -ne $expectedTitle) {
        throw "公告标题与列表不一致：$expectedTitle"
    }
}

function Assert-UnchangedNotice([string]$html, $link) {
    Assert-NoticeTitle $html $link.title
    # Check the article body, not a title, related link or script mentioning an unchanged price.
    $bodyMatch = [regex]::Match($html, '(?is)<div\b[^>]*\bid="content1"[^>]*>(?<body>.*?)<div\b')
    $article = [regex]::Replace($bodyMatch.Groups['body'].Value, '(?is)<(script|style)\b[^>]*>.*?</\1>', '')
    $body = [System.Net.WebUtility]::HtmlDecode([regex]::Replace($article, '<[^>]+>', ''))
    $body = [regex]::Replace($body, '\s+', '')
    $dateText = '{0}年{1}月{2}日' -f $link.published.Year, $link.published.Month, $link.published.Day
    if (-not $bodyMatch.Success -or $body -notmatch ('广东省发展改革委(?:员会)?' + [regex]::Escape($dateText)) -or
        $body -notmatch '(?:本次|我省)(?:汽[、，,]?柴油|汽油[、，,和及]+柴油|成品油)价格(?:不[作做]调整|不调整|暂不调整)[。；]' -or
        $body -match '(?:本次|我省)[^。；]{0,80}(?:上调|下调)') {
        throw "不调整公告正文未通过核实：$($link.title)"
    }
}

function Get-NoticePrices([string]$html, [string]$expectedTitle) {
    Assert-NoticeTitle $html $expectedTitle
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
$notices = @(foreach ($link in $links) {
    $html = Get-OfficialHtml $link.url
    $prices = if ($link.kind -eq 'unchanged') { Assert-UnchangedNotice $html $link } else { Get-NoticePrices $html $link.title }
    [pscustomobject]@{
        url = $link.url
        published = $link.published
        effective = $link.effective
        title = $link.title
        kind = $link.kind
        prices = $prices
    }
})
$latestNotice = $notices | Sort-Object -Property published -Descending | Select-Object -First 1
$noticeDate = $latestNotice.published.ToString('yyyy-MM-dd', $culture)
if ($region.latestNotice) {
    if ($noticeDate -lt $region.latestNotice.date -or
        ($noticeDate -eq $region.latestNotice.date -and
         ($latestNotice.kind -ne $region.latestNotice.kind -or $latestNotice.url -ne $region.latestNotice.sourceUrl))) {
        throw '官网最近公告回退或与已核实记录冲突，保留此前可信快照。'
    }
}
$priceNotices = @($notices | Where-Object { $_.kind -eq 'adjusted' })
$latest = $priceNotices | Sort-Object -Property effective -Descending | Select-Object -First 1
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
    foreach ($notice in $priceNotices) {
        $date = $notice.effective.ToString('yyyy-MM-dd', $culture)
        if ($historyByDate.ContainsKey($date) -and
            ($historyByDate[$date].price -ne $notice.prices[$grade] -or $historyByDate[$date].sourceUrl -ne $notice.url)) {
            throw '官网公告与已有历史价格冲突，保留此前可信快照。'
        }
        $historyByDate[$date] = [pscustomobject]@{ date = $date; price = $notice.prices[$grade]; sourceUrl = $notice.url }
    }
    $entry.history = @($historyByDate.Values | Sort-Object -Property date)
    $entry.price = $latest.prices[$grade]
}
$region.source.url = $latest.url
$region.effectiveLabel = $latest.published.ToString('yyyy-MM-dd', $culture) + ' 24:00 起'
$region | Add-Member -NotePropertyName latestNotice -NotePropertyValue ([pscustomobject]@{
    date = $noticeDate; kind = $latestNotice.kind; title = $latestNotice.title; sourceUrl = $latestNotice.url
}) -Force
$region.checkedAt = $chinaToday.ToString('yyyy-MM-dd', $culture)
$data.checkedAt = $region.checkedAt

$publishedDate = $noticeDate
$nextWindowDate = & node (Join-Path $PSScriptRoot 'next-window.cjs') $publishedDate $region.checkedAt
if ($LASTEXITCODE -ne 0) { throw '调价窗口计算失败，现有数据保持不变。' }
$data.nationalAdjustment.nextAdjustment = [pscustomobject]@{
    date = if ($nextWindowDate) { $nextWindowDate } else { $null }
    dateLabel = if ($nextWindowDate) { "预计 $nextWindowDate 24:00" } else { $null }
    sourceName = if ($nextWindowDate) { '国家发展改革委调价规则与国务院放假安排' } else { $null }
    sourceUrl = if ($nextWindowDate) { 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/201601/W020190905506573420251.pdf' } else { $null }
    holidaySourceUrl = if ($nextWindowDate) { 'https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html' } else { $null }
}
if ($data.nationalAdjustment.forecast.windowDate -ne $nextWindowDate) {
    $data.nationalAdjustment.forecast = [pscustomobject]@{
        direction = $null; amountPerLiter = $null; description = $null; sourceName = $null
        sourceUrl = $null; updatedAt = $null; windowDate = $null; workday = $null
    }
}
if ($nextWindowDate) {
    $marketResult = & node (Join-Path $PSScriptRoot 'read-market-forecast.cjs') $nextWindowDate $region.checkedAt
    if ($LASTEXITCODE -eq 0 -and $marketResult) {
        try {
            $market = $marketResult | ConvertFrom-Json
            if ($market.forecast) {
                # A cached source must not replace a newer estimate from the same cycle.
                if ($data.nationalAdjustment.forecast.updatedAt -and
                    $market.forecast.updatedAt -lt $data.nationalAdjustment.forecast.updatedAt) {
                    Write-Warning '来源返回了更早的市场估算，保留本轮较新的可信预测。'
                } else {
                    $data.nationalAdjustment.forecast = $market.forecast
                    Write-Output ("市场估算已核对，计算日期：" + $market.forecast.updatedAt + '；页面按计算日期标注时效。')
                }
            }
            else { Write-Warning "市场预测获取或校验失败：$($market.error)；保留本轮可信预测及原计算日期。" }
        } catch {
            Write-Warning '市场预测格式异常；原预测保留并由页面按日期判断是否过期。'
        }
    } else {
        Write-Warning '市场预测读取失败；原预测保留并由页面按日期判断是否过期。'
    }
}

$jsonText = $data | ConvertTo-Json -Depth 30
$jsonTemporary = Join-Path $dataDirectory '.prices.json.tmp'
$jsTemporary = Join-Path $dataDirectory '.prices.js.tmp'
try {
    Write-CrlfUtf8 $jsonTemporary $jsonText
    & node (Join-Path $PSScriptRoot 'format-snapshot.cjs') $jsonTemporary $jsTemporary
    if ($LASTEXITCODE -ne 0) { throw '快照格式化失败，现有数据保持不变。' }
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
