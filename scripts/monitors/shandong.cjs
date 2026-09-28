'use strict';

const HOSTNAME = 'fgw.weihai.gov.cn';
const LIST_URL = `https://${HOSTNAME}/col/col53887/index.html`;
const ARTICLE_PATH = /^\/art\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/art_53887_\d+\.html$/;
const OIL_TITLE = /(?:我省成品油价格调整|我省成品油价格(?:按机制)?(?:上调|下调))/;
const TABLE_TITLE = /^我省成品油价格调整[（(]\d{4}年\d{1,2}月\d{1,2}日[）)]$/;

function validDate(value, label) {
  const day = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(day.getTime()) ||
      day.toISOString().slice(0, 10) !== value) {
    throw new Error(`山东油价公告：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function officialArticleUrl(reference) {
  const url = new URL(reference, LIST_URL);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME ||
      url.username || url.password || url.search || url.hash || !ARTICLE_PATH.test(url.pathname)) {
    throw new Error(`山东油价公告：不是预期的威海市发改委地址：${url.href}`);
  }
  return url.href;
}

function plain(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:nbsp|ensp|emsp);|&#(?:160|x[aA]0);/gi, '')
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function latestEntry(html) {
  if (!html.includes('价格信息')) throw new Error('山东油价公告：官网价格信息列表结构已变化');
  const entries = [];
  for (const item of html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>\s*<span\b[^>]*>(\d{4}-\d{2}-\d{2})<\/span>/gi)) {
    const href = item[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const title = plain(item[1].match(/\btitle=["']([^"']+)["']/i)?.[1] || item[2]);
    if (!title.includes('成品油价格')) continue;
    if (!OIL_TITLE.test(title)) throw new Error(`山东油价公告：未知油价公告标题：${title}`);
    const publishedDate = validDate(item[3], '列表日期');
    const url = officialArticleUrl(href);
    const path = new URL(url).pathname.match(ARTICLE_PATH);
    const pathDate = validDate(`${path[1]}-${path[2].padStart(2, '0')}-${path[3].padStart(2, '0')}`, '公告路径日期');
    if (pathDate !== publishedDate) throw new Error(`山东油价公告：列表日期与公告路径不符：${url}`);
    entries.push({ url, publishedDate, title });
  }
  if (!entries.length) throw new Error('山东油价公告：官网列表没有可核验油价公告');
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate) ||
    Number(TABLE_TITLE.test(b.title)) - Number(TABLE_TITLE.test(a.title)));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate &&
      TABLE_TITLE.test(entries[0].title) === TABLE_TITLE.test(entries[1].title)) {
    throw new Error(`山东油价公告：最新调价日期有多个同类公告：${entries[0].publishedDate}`);
  }
  return entries[0];
}

function parsePrices(html, url) {
  const heading = html.indexOf('山东省成品油最高批发价格和零售价格表');
  const table = heading < 0 ? null : html.slice(heading).match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];
  if (!table || !plain(table).includes('最高零售价格') || !plain(table).includes('元/升')) {
    throw new Error(`山东油价公告：最高零售价格表或元/升单位缺失：${url}`);
  }
  const prices = {};
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => plain(cell[1]));
    const index = cells.findIndex(cell => ['92号', '95号', '0号'].includes(cell));
    if (index < 0) continue;
    const grade = cells[index] === '0号' ? 'diesel' : cells[index].slice(0, 2);
    if (grade in prices || !/^\d{1,2}\.\d{2}$/.test(cells[index + 1] || '') ||
        !/^\d{4,5}$/.test(cells[index + 2] || '') ||
        !/^\d{4,5}$/.test(cells[index + 3] || '')) {
      throw new Error(`山东油价公告：${grade} 元/升或批发价表列异常：${url}`);
    }
    prices[grade] = Number(cells[index + 1]);
  }
  if (Object.keys(prices).length !== 3 ||
      !(prices.diesel > 4 && prices.diesel < prices['92'] && prices['92'] < prices['95'] && prices['95'] < 20)) {
    throw new Error(`山东油价公告：缺少可信的 92、95 或 0 号元/升价格：${url}`);
  }
  return prices;
}

function parseArticle(html, entry) {
  const heading = html.match(/<meta\s+name=["']ArticleTitle["']\s+content=["']([^"']+)["']/i)?.[1];
  const pageDate = html.match(/<meta\s+name=["']PubDate["']\s+content=["'](\d{4}-\d{2}-\d{2})/i)?.[1];
  if (heading !== entry.title || !pageDate || validDate(pageDate, '正文日期') !== entry.publishedDate) {
    throw new Error(`山东油价公告：正文标题或发布日期与列表不符：${entry.url}`);
  }
  const [year, month, day] = entry.publishedDate.split('-').map(Number);
  if (!plain(html).includes(`自${year}年${month}月${day}日24时起`)) {
    throw new Error(`山东油价公告：24 时调价生效时间缺失：${entry.url}`);
  }
  return {
    url: entry.url,
    publishedDate: entry.publishedDate,
    effectiveDate: nextDate(entry.publishedDate),
    prices: parsePrices(html, entry.url),
    // 官网 HTML 价表可供提示，但人工核价快照只在复核后导入。
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'shandong',
  name: '山东',
  sourceName: '威海市发展和改革委员会（山东省价表）',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('山东油价公告：需要官网 HTML 读取器');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
