'use strict';

const HOSTNAME = 'fzggw.cq.gov.cn';
const LIST_URL = `https://${HOSTNAME}/zwgk/zfxxgkml/jgxx/jgzc/`;
const TITLE = /^(?:重庆市成品油价格(?:调整|下调|按机制调整)|国家继续实施调控，重庆市成品油价格适当调整)$/;
const ARTICLE_PATH = /^\/zwgk\/zfxxgkml\/jgxx\/jgzc\/(\d{6})\/t(\d{8})_\d+\.html$/;

function validDate(value, label) {
  const day = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(day.getTime()) ||
      day.toISOString().slice(0, 10) !== value) {
    throw new Error(`重庆油价公告：${label}无效：${value}`);
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
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username || url.password ||
      url.search || url.hash || !ARTICLE_PATH.test(url.pathname)) {
    throw new Error(`重庆油价公告：不是预期的市发改委地址：${url.href}`);
  }
  return url.href;
}

function compact(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp);|&#(?:160|x[aA]0);/gi, '')
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function latestEntry(html) {
  if (!html.includes('价格政策')) throw new Error('重庆油价公告：官网价格政策栏目结构已变化');
  const entries = [];
  for (const row of html.matchAll(/<li\b[^>]*class="clearfix"[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[^<]*<\/a>\s*<span\b[^>]*class="rt"[^>]*>(\d{4}-\d{2}-\d{2})<\/span>\s*<\/li>/gi)) {
    if (!row[2].includes('成品油价格')) continue;
    if (!TITLE.test(row[2])) throw new Error(`重庆油价公告：未知的油价公告标题：${row[2]}`);
    const url = officialArticleUrl(row[1]);
    const path = new URL(url).pathname.match(ARTICLE_PATH);
    if (path[1] !== path[2].slice(0, 6)) {
      throw new Error(`重庆油价公告：路径月份与日期不符：${url}`);
    }
    const pathDate = validDate(`${path[2].slice(0, 4)}-${path[2].slice(4, 6)}-${path[2].slice(6, 8)}`, '路径日期');
    const pageDate = validDate(row[3], '列表日期');
    if (pageDate !== pathDate) throw new Error(`重庆油价公告：路径与列表日期冲突：${url}`);
    entries.push({ url, pageDate, title: row[2] });
  }
  if (!entries.length) throw new Error('重庆油价公告：官网列表没有可核验油价公告');
  entries.sort((a, b) => b.pageDate.localeCompare(a.pageDate));
  if (entries.length > 1 && entries[0].pageDate === entries[1].pageDate) {
    throw new Error(`重庆油价公告：最新公告日期不唯一：${entries[0].pageDate}`);
  }
  return entries[0];
}

function parsePrices(html, url) {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(match => match[0]);
  const table = tables.find(item => {
    const text = compact(item);
    return text.includes('最高销售价格') && text.includes('零售价（元/升）') && text.includes('92号汽油');
  });
  if (!table) throw new Error(`重庆油价公告：最高销售价格表或元/升单位缺失：${url}`);
  const prices = {};
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => compact(cell[1]));
    const grade = { '92号汽油': '92', '95号汽油': '95', '0号柴油': 'diesel' }[cells[0]];
    if (!grade) continue;
    const expectedVersion = grade === 'diesel' ? '（Ⅵ）' : '（ⅥB）';
    if (grade in prices || cells.length !== 5 || cells[1] !== expectedVersion ||
        !/^\d{1,2}\.\d{2}$/.test(cells[2]) ||
        !/^\d{4,5}$/.test(cells[3]) || !/^\d{4,5}$/.test(cells[4]) ||
        Number(cells[3]) - Number(cells[4]) !== 300) {
      throw new Error(`重庆油价公告：${grade} 元/升或吨价表列异常：${url}`);
    }
    prices[grade] = Number(cells[2]);
  }
  if (Object.keys(prices).length !== 3 ||
      !(prices.diesel > 4 && prices.diesel < prices['92'] && prices['92'] < prices['95'] && prices['95'] < 20)) {
    throw new Error(`重庆油价公告：缺少可信的 92、95 或 0 号元/升价格：${url}`);
  }
  return prices;
}

function parseArticle(html, entry) {
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i)?.[1];
  const pageDate = html.match(/<meta\s+name="PubDate"\s+content="(\d{4}-\d{2}-\d{2})/i)?.[1];
  const source = html.match(/<meta\s+name="ContentSource"\s+content="([^"]+)"/i)?.[1];
  if (title !== entry.title || !pageDate || validDate(pageDate, '正文日期') !== entry.pageDate ||
      source !== '市发展改革委') {
    throw new Error(`重庆油价公告：正文标题、来源或发布日期与列表不符：${entry.url}`);
  }
  const adjusted = compact(html).match(/现将我市汽、柴油最高零售、批发价格公布如下，自(\d{4})年(\d{1,2})月(\d{1,2})日24时起执行/);
  if (!adjusted) throw new Error(`重庆油价公告：全市价格或 24 时生效时间缺失：${entry.url}`);
  const publishedDate = validDate(`${adjusted[1]}-${adjusted[2].padStart(2, '0')}-${adjusted[3].padStart(2, '0')}`, '调价日期');
  const lag = Date.parse(`${entry.pageDate}T00:00:00Z`) - Date.parse(`${publishedDate}T00:00:00Z`);
  if (lag < 0 || lag > 7 * 86_400_000) {
    // 官网曾在调价次日上站；公告发布日期不能早于调价日，也不能相隔过久。
    throw new Error(`重庆油价公告：公告发布日期与调价日期冲突：${entry.url}`);
  }
  return { url: entry.url, publishedDate, effectiveDate: nextDate(publishedDate),
    prices: parsePrices(html, entry.url), requiresManualPriceReview: true };
}

module.exports = {
  id: 'chongqing',
  name: '重庆',
  sourceName: '重庆市发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('重庆油价公告：需要官网 HTML 读取器');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
