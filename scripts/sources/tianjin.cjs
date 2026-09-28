'use strict';

const BASE_URL = 'https://fzgg.tj.gov.cn/xxfb/tzggx/';
const TITLE = '天津市发展改革委关于调整我市成品油价格的公告';
const NEWS_TITLE = '我市今日调整成品油价格';
const MAX_PAGES = 100;

function compact(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp);|&#(?:160|x[aA]0);/gi, ' ')
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function date(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`天津油价：${label}无效：${value}`);
  }
  return value;
}

function nextDay(value) {
  const result = new Date(`${value}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + 1);
  return result.toISOString().slice(0, 10);
}

function listEntries(html, pageUrl) {
  const count = html.match(/var\s+countPage\s*=\s*(\d+)/);
  if (!count || Number(count[1]) < 1 || Number(count[1]) > MAX_PAGES) {
    throw new Error(`天津油价：列表分页数量异常：${pageUrl}`);
  }
  const list = html.match(/<ul\s+class="list-main-group"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!list) throw new Error(`天津油价：缺少公告列表：${pageUrl}`);
  const entries = [];
  for (const item of list[1].matchAll(/<li>\s*([\s\S]*?)<\/li>/gi)) {
    const link = item[1].match(/<a\b[^>]*\bonclick="isDownLoad\(this,'([^']+)'\)"[^>]*\btitle='([^']+)'[^>]*>/i);
    const listedDate = item[1].match(/<span\s+class="list-main-date">\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i);
    if (!link || !listedDate) throw new Error(`天津油价：公告列表结构异常：${pageUrl}`);
    const url = new URL(link[1], pageUrl);
    if (url.hostname !== 'fzgg.tj.gov.cn' || !url.pathname.endsWith('.html')) {
      throw new Error(`天津油价：公告链接异常：${url.href}`);
    }
    entries.push({
      title: compact(link[2]),
      publishedDate: date(listedDate[1], '列表发布日期'),
      url: url.href,
    });
  }
  if (!entries.length) throw new Error(`天津油价：公告列表为空：${pageUrl}`);
  return { pageCount: Number(count[1]), entries };
}

function articlePrices(html, url) {
  const tables = [...html.matchAll(/<div\s+class="ue_table"[^>]*>\s*(<table\b[\s\S]*?<\/table>)\s*<\/div>/gi)];
  if (tables.length !== 1) throw new Error(`天津油价：价格表数量异常：${url}`);
  const rows = [...tables[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => compact(cell[1])));
  if (rows.length < 5 ||
      rows[0].length !== 3 || rows[0][0] !== '品种' ||
      rows[0][1] !== '最高零售价格' || !rows[0][2].startsWith('最高批发价格') ||
      rows[1].length !== 3 ||
      rows[1][0] !== '（元/吨）' || rows[1][1] !== '（元/升）' || rows[1][2] !== '（元/吨）') {
    throw new Error(`天津油价：价格表列标题异常：${url}`);
  }
  const prices = {};
  for (const [grade, label] of [
    ['92', '92号乙醇汽油'],
    ['95', '95号乙醇汽油'],
    ['diesel', '0号柴油（标准品）'],
  ]) {
    const matches = rows.filter((row) => row[0] === label);
    if (matches.length !== 1 || matches[0].length !== 4) {
      throw new Error(`天津油价：${label}价格行缺失或不唯一：${url}`);
    }
    const value = matches[0][2];
    if (!/^\d+\.\d{2}$/.test(value) || Number(value) <= 0) {
      throw new Error(`天津油价：${label}元/升价格异常：${value}`);
    }
    prices[grade] = Number(value);
  }
  return prices;
}

function newsPrices(text, url) {
  const paragraphs = [...text.matchAll(/我市调整后的成品油最高零售价格每升分别为：([^。]+)。/g)];
  if (paragraphs.length !== 1) throw new Error(`天津油价：缺少每升最高零售价格段落：${url}`);
  const prices = {};
  for (const [grade, label] of [['92', '92号汽油'], ['95', '95号汽油'], ['diesel', '0号柴油']]) {
    const matches = [...paragraphs[0][1].matchAll(new RegExp(`${label}(\\d+\\.\\d{2})元`, 'g'))];
    if (matches.length !== 1 || Number(matches[0][1]) <= 0) {
      throw new Error(`天津油价：${label}元/升价格缺失或不唯一：${url}`);
    }
    prices[grade] = Number(matches[0][1]);
  }
  return prices;
}

function parseArticle(html, entry) {
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i);
  if (!title || compact(title[1]) !== entry.title || ![TITLE, NEWS_TITLE].includes(entry.title)) {
    throw new Error(`天津油价：公告标题与列表不符：${entry.url}`);
  }
  const published = html.match(/<meta\s+name="PubDate"\s+content="(\d{4})\/(\d{2})\/(\d{2})\s+\d{2}:\d{2}:\d{2}"/i);
  if (!published) throw new Error(`天津油价：缺少发布日期：${entry.url}`);
  const publishedDate = date(`${published[1]}-${published[2]}-${published[3]}`, '发布日期');
  if (publishedDate !== entry.publishedDate) {
    throw new Error(`天津油价：列表与正文发布日期不符：${entry.url}`);
  }
  const content = html.match(/<div\s+class="details-main-content"\s+id="zoom">([\s\S]*?)<\/div>\s*<\/div>/i);
  if (!content) throw new Error(`天津油价：缺少公告正文：${entry.url}`);
  const text = compact(content[1]);
  const timePattern = entry.title === TITLE
    ? /自(\d{4})年(\d{1,2})月(\d{1,2})日24时起执行/g
    : /决定自(\d{4})年(\d{1,2})月(\d{1,2})日24时起(?:上|下)调成品油价格/g;
  const times = [...text.matchAll(timePattern)];
  if (times.length !== 1) throw new Error(`天津油价：生效时间缺失或不唯一：${entry.url}`);
  const announcedDate = date(`${times[0][1]}-${times[0][2].padStart(2, '0')}-${times[0][3].padStart(2, '0')}`, '正文调价日期');
  if (announcedDate !== publishedDate) {
    throw new Error(`天津油价：生效时间与发布日期不符：${entry.url}`);
  }
  return {
    effectiveDate: nextDay(announcedDate),
    publishedDate,
    url: entry.url,
    prices: entry.title === TITLE ? articlePrices(html, entry.url) : newsPrices(text, entry.url),
  };
}

module.exports = {
  id: 'tianjin',
  name: '天津',
  sourceName: '天津市发展和改革委员会',
  priceScope: '天津市成品油最高零售价格（元/升）',
  allowedHostnames: ['fzgg.tj.gov.cn'],
  async collect({ getText, today }) {
    if (typeof getText !== 'function') throw new TypeError('天津油价：getText 必须为函数');
    const todayDate = date(today instanceof Date ? today.toISOString().slice(0, 10) : today, '今天');
    const cutoffDate = new Date(`${todayDate}T00:00:00Z`);
    cutoffDate.setUTCFullYear(cutoffDate.getUTCFullYear() - 1);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const notices = [];
    let pageCount = null;
    let lastDate = null;
    let latestRecognizedDate = null;
    for (let page = 0; page < (pageCount ?? 1); page += 1) {
      const pageUrl = page === 0 ? BASE_URL : `${BASE_URL}index_${page}.html`;
      const listing = listEntries(await getText(pageUrl), pageUrl);
      if (pageCount === null) pageCount = listing.pageCount;
      else if (pageCount !== listing.pageCount) throw new Error('天津油价：采集期间列表分页数量变化');
      for (const entry of listing.entries) {
        if (lastDate && entry.publishedDate > lastDate) {
          throw new Error('天津油价：公告列表日期顺序异常');
        }
        lastDate = entry.publishedDate;
        if (entry.publishedDate < cutoff) continue;
        if (entry.title !== TITLE && entry.title !== NEWS_TITLE) {
          // Older news releases can describe a price change without the official price table.
          if (entry.title.includes('成品油价格') && !latestRecognizedDate) {
            throw new Error(`天津油价：未知的成品油公告标题：${entry.title}`);
          }
          continue;
        }
        latestRecognizedDate ??= entry.publishedDate;
        if (!/^\/xxfb\/tzggx\/\d{6}\/t\d{8}_\d+\.html$/.test(new URL(entry.url).pathname)) {
          throw new Error(`天津油价：油价公告链接异常：${entry.url}`);
        }
        const notice = parseArticle(await getText(entry.url), entry);
        if (notice.effectiveDate <= todayDate) notices.push(notice);
      }
      if (lastDate < cutoff) break;
    }
    if (!notices.length) throw new Error('天津油价：未找到已生效的官方公告');
    notices.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    for (let i = 1; i < notices.length; i += 1) {
      if (notices[i].effectiveDate === notices[i - 1].effectiveDate) {
        throw new Error(`天津油价：生效日期重复：${notices[i].effectiveDate}`);
      }
    }
    return notices;
  },
};
