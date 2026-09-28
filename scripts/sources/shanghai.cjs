'use strict';

const BASE_URL = 'https://fgw.sh.gov.cn/fgw_jggl/';
const HOST = 'fgw.sh.gov.cn';
const TITLE_PATTERN = /^上海市发展和改革委员会关于车用汽、柴油价格的通知（(\d{4})年(\d{1,2})月(\d{1,2})日）$/;
const MAX_PAGES = 100;
const LOOKBACK_DAYS = 365;

function compact(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp);|&#(?:160|x[aA]0);/gi, ' ')
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/[\s\u00a0\u2000-\u200b\u3000\u2003]/g, '');
}

function date(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`上海油价：${label}无效：${value}`);
  }
  return value;
}

function fromParts(year, month, day, label) {
  return date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`, label);
}

function nextDay(value) {
  const result = new Date(`${value}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + 1);
  return result.toISOString().slice(0, 10);
}

function listEntries(html, pageUrl) {
  const count = html.match(/totalPage:\s*(\d+)/);
  if (!count || Number(count[1]) < 1 || Number(count[1]) > MAX_PAGES) {
    throw new Error(`上海油价：列表分页数量异常：${pageUrl}`);
  }
  const list = html.match(/<ul\s+class="zzwj-list trout-region-list"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!list) throw new Error(`上海油价：缺少价格管理公告列表：${pageUrl}`);
  const entries = [];
  for (const item of list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const link = item[1].match(/<a\s+href="([^"]+)"\s+title="([^"]+)"/i);
    const published = item[1].match(/发布日期：\s*(\d{4}-\d{2}-\d{2})/);
    if (!link || !published) throw new Error(`上海油价：公告列表结构异常：${pageUrl}`);
    const title = compact(link[2]);
    const url = new URL(link[1], pageUrl);
    if ((TITLE_PATTERN.test(title) || title.includes('车用汽、柴油价格')) &&
        (!['http:', 'https:'].includes(url.protocol) || url.hostname !== HOST ||
        !/^\/fgw_jggl\/\d{8}\/[a-f0-9]{32}\.html$/.test(url.pathname) || url.search || url.hash)) {
      throw new Error(`上海油价：公告链接异常：${url.href}`);
    }
    // The official list uses HTTP links, while the same articles are served over HTTPS.
    url.protocol = 'https:';
    entries.push({
      title,
      publishedDate: date(published[1], '列表发布日期'),
      url: url.href,
    });
  }
  if (!entries.length) throw new Error(`上海油价：公告列表为空：${pageUrl}`);
  return { pageCount: Number(count[1]), entries };
}

function tableRows(html, url) {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]
    .map((match) => match[0])
    .filter((table) => compact(table).includes('上海市车用汽、柴油最高零售价格表') ||
      (compact(table).includes('最高零售价') && compact(table).includes('元/升')));
  if (tables.length !== 1) throw new Error(`上海油价：元/升价格表数量异常：${url}`);
  const rows = [...tables[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => compact(cell[1])));
  if (rows.length < 11 || rows[0].join('|') !== '标号|单位|最高零售价') {
    throw new Error(`上海油价：价格表列标题异常：${url}`);
  }
  return rows;
}

function priceRow(rows, label, url) {
  const indices = rows.flatMap((row, index) => row[0] === label ? [index] : []);
  if (indices.length !== 1) throw new Error(`上海油价：${label}价格行缺失或重复：${url}`);
  const index = indices[0];
  const ton = rows[index];
  const litre = rows[index + 1];
  if (ton.length !== 3 || ton[1] !== '元/吨' || !/^\d+$/.test(ton[2]) ||
      !litre || litre.length !== 2 || litre[0] !== '元/升' ||
      !/^\d+\.\d{2}$/.test(litre[1])) {
    throw new Error(`上海油价：${label}元/升价格格式异常：${url}`);
  }
  return { perTon: Number(ton[2]), perLitre: Number(litre[1]) };
}

function parseArticle(html, entry) {
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i);
  const published = html.match(/<meta\s+name="PubDate"\s+content="(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}"/i);
  const source = html.match(/<meta\s+name="ContentSource"\s+content="([^"]+)"/i);
  if (!title || compact(title[1]) !== entry.title || !source ||
      compact(source[1]) !== '上海市发展和改革委员会') {
    throw new Error(`上海油价：公告标题或发布机关与列表不符：${entry.url}`);
  }
  if (!published || date(published[1], '正文发布日期') !== entry.publishedDate) {
    throw new Error(`上海油价：正文发布日期与列表不符：${entry.url}`);
  }
  const announced = entry.title.match(TITLE_PATTERN);
  if (!announced) throw new Error(`上海油价：公告标题日期异常：${entry.url}`);
  const announcedDate = fromParts(announced[1], announced[2], announced[3], '标题日期');
  if (announcedDate !== entry.publishedDate ||
      !entry.url.includes(`/fgw_jggl/${announcedDate.replaceAll('-', '')}/`)) {
    throw new Error(`上海油价：标题、列表和链接日期不符：${entry.url}`);
  }
  const contentStart = html.indexOf('id="ivs_content"');
  if (contentStart < 0) throw new Error(`上海油价：缺少公告正文：${entry.url}`);
  const content = html.slice(contentStart);
  const text = compact(content.slice(0, content.indexOf('<table')));
  const effectiveTimes = [...text.matchAll(/上述调整后的价格自(\d{4})年(\d{1,2})月(\d{1,2})日24时起执行/g)];
  if (effectiveTimes.length !== 1 ||
      fromParts(effectiveTimes[0][1], effectiveTimes[0][2], effectiveTimes[0][3], '执行日期') !== announcedDate) {
    throw new Error(`上海油价：正文24时执行日期与标题不符：${entry.url}`);
  }
  const rows = tableRows(content, entry.url);
  const standard = priceRow(rows, '89号汽油', entry.url);
  const diesel = priceRow(rows, '0号柴油', entry.url);
  const tonStatement = text.match(/89号汽油和0号柴油最高零售价格每吨分别为(\d+)元和(\d+)元/);
  if (!tonStatement || Number(tonStatement[1]) !== standard.perTon ||
      Number(tonStatement[2]) !== diesel.perTon) {
    throw new Error(`上海油价：正文与表格吨价不符：${entry.url}`);
  }
  return {
    effectiveDate: nextDay(announcedDate),
    publishedDate: entry.publishedDate,
    url: entry.url,
    prices: {
      '92': priceRow(rows, '92号汽油', entry.url).perLitre,
      '95': priceRow(rows, '95号汽油', entry.url).perLitre,
      diesel: diesel.perLitre,
    },
  };
}

module.exports = {
  id: 'shanghai',
  name: '上海',
  sourceName: '上海市发展和改革委员会',
  priceScope: '上海市车用汽、柴油最高零售价格（元/升）',
  allowedHostnames: [HOST],
  async collect({ getText, today }) {
    if (typeof getText !== 'function') throw new TypeError('上海油价：getText 必须为函数');
    const todayDate = date(today instanceof Date ? today.toISOString().slice(0, 10) : today, '今天');
    const cutoffDate = new Date(`${todayDate}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - LOOKBACK_DAYS);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    let pageCount = null;
    let lastDate = null;
    const notices = [];
    for (let page = 1; page <= (pageCount ?? 1); page += 1) {
      const pageUrl = page === 1 ? BASE_URL : `${BASE_URL}index_${page}.html`;
      const listing = listEntries(await getText(pageUrl), pageUrl);
      if (pageCount === null) pageCount = listing.pageCount;
      else if (pageCount !== listing.pageCount) throw new Error('上海油价：采集期间分页数量变化');
      for (const entry of listing.entries) {
        if (lastDate && entry.publishedDate > lastDate) {
          throw new Error('上海油价：公告列表日期顺序异常');
        }
        lastDate = entry.publishedDate;
        if (entry.publishedDate < cutoff) continue;
        if (!TITLE_PATTERN.test(entry.title)) {
          if (entry.title.includes('车用汽、柴油价格')) {
            throw new Error(`上海油价：未知的车用汽、柴油价格公告：${entry.title}`);
          }
          continue;
        }
        const notice = parseArticle(await getText(entry.url), entry);
        if (notice.effectiveDate <= todayDate) notices.push(notice);
      }
      if (lastDate < cutoff) break;
    }
    if (!notices.length) throw new Error('上海油价：近一年未找到已生效的官方公告');
    notices.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    for (let index = 1; index < notices.length; index += 1) {
      if (notices[index].effectiveDate === notices[index - 1].effectiveDate) {
        throw new Error(`上海油价：生效日期重复：${notices[index].effectiveDate}`);
      }
    }
    return notices;
  },
};
