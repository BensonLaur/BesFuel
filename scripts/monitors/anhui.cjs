'use strict';

const HOSTNAME = 'fzggw.ah.gov.cn';
const LIST_URL = `https://${HOSTNAME}/ywdt/tzgg/index.html`;
const TITLE = '安徽省发展改革委关于调整安徽省成品油价格的通告';
const ARTICLE_PATH = /^\/ywdt\/tzgg\/\d+\.html$/;

function validDate(value, label) {
  const day = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
    throw new Error(`安徽油价公告：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function officialUrl(reference) {
  const url = new URL(reference, LIST_URL);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME ||
      url.username || url.password || url.search || url.hash ||
      !ARTICLE_PATH.test(url.pathname)) {
    throw new Error(`安徽油价公告：不是预期的省发改委地址：${url.href}`);
  }
  return url.href;
}

function latestEntry(html) {
  const list = html.match(/<ul class="doc_list list-49637171">([\s\S]*?)<\/ul>/i)?.[1];
  if (!list) throw new Error('安徽油价公告：官网公告列表结构已变化');
  const entries = [];
  const oilTitles = [...list.matchAll(/title="([^"]*成品油价格[^"]*)"/g)];
  for (const item of list.matchAll(/<li\b[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*title="([^"]+)"[\s\S]*?<span class="right date">(\d{4}-\d{2}-\d{2})<\/span>[\s\S]*?<\/li>/gi)) {
    if (!item[2].includes('成品油价格')) continue;
    if (item[2] !== TITLE) throw new Error(`安徽油价公告：未知油价公告标题：${item[2]}`);
    entries.push({
      url: officialUrl(item[1]),
      publishedDate: validDate(item[3], '列表日期'),
    });
  }
  if (!entries.length || entries.length !== oilTitles.length) {
    throw new Error('安徽油价公告：官网列表没有可核验公告或结构已变化');
  }
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`安徽油价公告：同日公告不唯一：${entries[0].publishedDate}`);
  }
  return entries[0];
}

function cellText(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, '').replace(/\s|\u00a0/g, '');
}

function parsePrices(html) {
  const prices = {};
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(cell => cellText(cell[1]));
    if (cells.length !== 4) continue;
    const grade = /^92#国ⅥB乙醇汽油$/.test(cells[0]) ? '92' :
      /^95#国ⅥB乙醇汽油$/.test(cells[0]) ? '95' :
        /^0#国Ⅵ车用柴油$/.test(cells[0]) ? 'diesel' : null;
    if (!grade) continue;
    if (grade in prices || !/^\d{4,5}$/.test(cells[1]) ||
        !/^\d{1,2}\.\d{2}$/.test(cells[2]) ||
        !/^\d{4,5}$/.test(cells[3])) {
      throw new Error(`安徽油价公告：${grade} 价格表列无效`);
    }
    prices[grade] = Number(cells[2]);
  }
  if (Object.keys(prices).length !== 3 ||
      Object.values(prices).some(value => value < 4 || value > 20)) {
    throw new Error('安徽油价公告：缺少可信的 92、95 或 0 号元/升价格');
  }
  return prices;
}

function parseArticle(html, entry) {
  const title = html.match(/<h1 class="newstitle">([^<]+)<\/h1>/i)?.[1]?.trim();
  const published = html.match(/发布日期：\s*(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}/)?.[1];
  if (title !== TITLE || !published || validDate(published, '正文日期') !== entry.publishedDate ||
      !/信息来源：省发展改革委/.test(html)) {
    throw new Error(`安徽油价公告：正文标题、来源或发布日期与列表不符：${entry.url}`);
  }
  const text = cellText(html);
  const [year, month, day] = entry.publishedDate.split('-').map(Number);
  if (!text.includes('安徽省汽柴油最高零售和批发价格表') ||
      !text.includes(`自${year}年${month}月${day}日24时起执行`) ||
      !text.includes('单位：元／吨，元／升')) {
    throw new Error(`安徽油价公告：表格、生效时间或单位异常：${entry.url}`);
  }
  return {
    url: entry.url,
    publishedDate: entry.publishedDate,
    effectiveDate: nextDate(entry.publishedDate),
    prices: parsePrices(html),
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'anhui',
  name: '安徽',
  sourceName: '安徽省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('安徽油价公告：需要官方 HTML 读取器');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
