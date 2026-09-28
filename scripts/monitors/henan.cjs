'use strict';

const HOSTNAME = 'fgw.henan.gov.cn';
const LIST_URL = `https://${HOSTNAME}/xwzx/tzgg/cpydj/`;
const ARTICLE_PATH = /^\/(\d{4})\/(\d{2})-(\d{2})\/\d+\.html$/;
const TITLES = new Set(['我省成品油价格调整', '明日起我省调整成品油价格']);

function validDate(value, label) {
  const day = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
    throw new Error(`河南油价公告：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function articleUrl(reference, publishedDate) {
  const url = new URL(reference, LIST_URL);
  // 官网列表仍使用 HTTP 链接，但相同文章在 HTTPS 下可核验。
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== HOSTNAME ||
      url.username || url.password || url.search || url.hash ||
      !ARTICLE_PATH.test(url.pathname)) {
    throw new Error(`河南油价公告：不是预期的省发改委地址：${url.href}`);
  }
  const pathDate = url.pathname.match(ARTICLE_PATH).slice(1, 4).join('-');
  if (pathDate !== publishedDate) {
    throw new Error(`河南油价公告：链接日期与列表不符：${url.href}`);
  }
  url.protocol = 'https:';
  return url.href;
}

function latestEntry(html) {
  const block = html.match(/<div class="news-list">([\s\S]*?)<div id="pageArea"/i)?.[1];
  if (!block) throw new Error('河南油价公告：官网专栏列表结构已变化');
  const entries = [];
  for (const item of block.matchAll(/<li>\s*<a href="([^"]+)" target="_blank">([^<]+)<\/a><span>(\d{4}-\d{2}-\d{2})<\/span>\s*<\/li>/gi)) {
    if (!item[2].includes('成品油')) continue;
    if (!TITLES.has(item[2])) throw new Error(`河南油价公告：未知公告标题：${item[2]}`);
    const publishedDate = validDate(item[3], '列表日期');
    entries.push({ title: item[2], publishedDate, url: articleUrl(item[1], publishedDate) });
  }
  if (!entries.length || !block.includes('成品油')) {
    throw new Error('河南油价公告：官网专栏缺少可核验调价公告');
  }
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`河南油价公告：同日公告不唯一：${entries[0].publishedDate}`);
  }
  return entries[0];
}

function parseArticle(html, entry) {
  const title = html.match(/<p class="yTit">([^<]+)<\/p>/i)?.[1]?.trim();
  const date = html.match(/<span>时间：(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}<\/span>/)?.[1];
  if (title !== entry.title || !date || validDate(date, '正文日期') !== entry.publishedDate ||
      !/<span>来源：价管处<\/span>/.test(html)) {
    throw new Error(`河南油价公告：标题、日期或来源与列表不符：${entry.url}`);
  }
  const content = html.match(/<div class="conBox">([\s\S]*?)<\/div>/i)?.[1];
  if (!content) throw new Error(`河南油价公告：正文缺失：${entry.url}`);
  const text = content.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, '').replace(/\s|\u00a0/g, '');
  const [year, month, day] = entry.publishedDate.split('-').map(Number);
  if (!text.includes(`自${year}年${month}月${day}日24时起`) ||
      !text.includes('我省国VIB车用乙醇汽油和国VI车用柴油最高零售价格和批发价格')) {
    throw new Error(`河南油价公告：生效日或适用油品异常：${entry.url}`);
  }
  const retail = text.split('最高零售价格：')[1]?.split('最高批发价格：')[0];
  if (!retail) throw new Error(`河南油价公告：零售价格段缺失：${entry.url}`);
  const prices = {};
  for (const [grade, label] of [['92', '92号汽油'], ['95', '95号汽油'], ['diesel', '0号柴油']]) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...retail.matchAll(new RegExp(`${escaped}价格(?:上调|下调)\\d+(?:\\.\\d+)?元/升，由\\d+(?:\\.\\d+)?元/升调整为(\\d+(?:\\.\\d+)?)元/升`, 'g'))];
    if (matches.length !== 1) throw new Error(`河南油价公告：${label}最高零售升价缺失或不唯一`);
    prices[grade] = Number(matches[0][1]);
    if (!Number.isFinite(prices[grade]) || prices[grade] < 4 || prices[grade] > 20) {
      throw new Error(`河南油价公告：${label}升价异常`);
    }
  }
  return {
    url: entry.url,
    publishedDate: entry.publishedDate,
    effectiveDate: nextDate(entry.publishedDate),
    prices,
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'henan',
  name: '河南',
  sourceName: '河南省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('河南油价公告：需要官方 HTML 读取器');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
