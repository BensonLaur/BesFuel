'use strict';

const HOSTNAME = 'fgw.nmg.gov.cn';
const LIST_URL = 'https://fgw.nmg.gov.cn/ywgz/jfgz/cpyjg/index.html';
const ARTICLE_PATH = /^\/ywgz\/jfgz\/cpyjg\/(\d{6})\/t(\d{8})_\d+\.html$/;
const NOTICE_TITLE = /^我区成品油价格(?:按机制)?调整$/;
const EAST_HEADING = '内蒙古自治区东部价区汽、柴油最高批发、零售价格表';
const WEST_HEADING = '内蒙古自治区西部价区汽、柴油最高批发、零售价格表';
const ZONE_SCOPE = '东部价区包括呼伦贝尔市、兴安盟、通辽市、赤峰市和锡林郭勒盟';

function chinaDate() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`内蒙古东部价区：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function chineseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function plain(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s|\u00a0/g, '');
}

function officialUrl(reference) {
  const url = new URL(reference, LIST_URL);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username || url.password ||
      url.search || url.hash || !ARTICLE_PATH.test(url.pathname)) {
    throw new Error(`内蒙古东部价区：公告不是预期的自治区发改委地址：${url.href}`);
  }
  return url.href;
}

function listing(html) {
  const entries = [];
  for (const item of html.matchAll(/<li>\s*<a\s+href="([^"]+)"[^>]*\btitle="([^"]+)"[^>]*>[^<]*<\/a>\s*<span>(\d{4}-\d{2}-\d{2})<\/span>\s*<\/li>/gi)) {
    const title = item[2].trim();
    if (!title.includes('成品油价格')) continue;
    if (!NOTICE_TITLE.test(title)) throw new Error(`内蒙古东部价区：未知油价公告标题：${title}`);
    const publishedDate = validDate(item[3], '列表日期');
    const url = officialUrl(item[1]);
    const path = new URL(url).pathname.match(ARTICLE_PATH);
    if (path[1] !== publishedDate.slice(0, 4) + publishedDate.slice(5, 7) ||
        path[2] !== publishedDate.replace(/-/g, '')) {
      throw new Error(`内蒙古东部价区：公告路径与列表日期不符：${url}`);
    }
    entries.push({ title, publishedDate, url });
  }
  const articleLinks = [...html.matchAll(/<a\s+href="\.\/\d{6}\/t\d{8}_\d+\.html"[^>]*>/gi)];
  if (articleLinks.length !== entries.length) {
    throw new Error('内蒙古东部价区：官网列表结构变化，部分调价公告无法核验');
  }
  return entries;
}

function priceRows(table, day) {
  const rows = [...table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((row) =>
    [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => plain(cell[1])));
  if (rows.length < 9 || rows[0][0] !== '品种' ||
      !rows[0].includes('最高零售价') ||
      !rows.some((row) => row.includes('元/吨') && row.includes('元/升'))) {
    throw new Error(`内蒙古东部价区：价格表表头或单位异常：${day}`);
  }
  const prices = {};
  for (const [grade, label] of [['92', '92号'], ['95', '95号'], ['diesel', '0号']]) {
    const matches = rows.filter((row) => row.some((cell) => cell.startsWith(label)));
    if (matches.length !== 1) throw new Error(`内蒙古东部价区：${grade} 价格行缺失或重复：${day}`);
    const row = matches[0];
    const index = row.findIndex((cell) => cell.startsWith(label));
    const ton = row[index + 1];
    const litre = row[index + 2];
    if (!/^\d{4,5}$/.test(ton) || !/^\d{1,2}\.\d{2}$/.test(litre) ||
        Number(litre) < 1 || Number(litre) > 30) {
      throw new Error(`内蒙古东部价区：${grade} 元/升列异常：${day}`);
    }
    prices[grade] = Number(litre);
  }
  if (!(prices['95'] > prices['92'] && prices['92'] > prices.diesel)) {
    throw new Error(`内蒙古东部价区：油号价格关系异常：${day}`);
  }
  return prices;
}

function article(html, entry) {
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content=['"]([^'"]+)['"]/i)?.[1];
  const pub = html.match(/<meta\s+name="PubDate"\s+content="(\d{4})年(\d{2})月(\d{2})日\s+\d{2}:\d{2}"/i);
  if (title !== entry.title || !pub ||
      validDate(`${pub[1]}-${pub[2]}-${pub[3]}`, '网页发布日期') !== entry.publishedDate) {
    throw new Error(`内蒙古东部价区：正文标题或发布日期与列表不符：${entry.url}`);
  }
  const dateText = chineseDate(entry.publishedDate);
  const text = plain(html);
  if (!text.includes(`自${dateText}24时起`) || !text.includes(ZONE_SCOPE)) {
    throw new Error(`内蒙古东部价区：正文生效日期或价区范围不符：${entry.url}`);
  }
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
  if (tables.length !== 2) throw new Error(`内蒙古东部价区：东西部价格表数量异常：${entry.url}`);
  const beforeWest = plain(html.slice(0, tables[0].index));
  const beforeEast = plain(html.slice(tables[0].index + tables[0][0].length, tables[1].index));
  if (!beforeWest.includes(`${WEST_HEADING}（自${dateText}24时起执行）`) ||
      !beforeEast.includes(`${EAST_HEADING}（自${dateText}24时起执行）`)) {
    throw new Error(`内蒙古东部价区：附表价区顺序或日期异常：${entry.url}`);
  }
  return { ...entry, effectiveDate: nextDate(entry.publishedDate),
    prices: priceRows(tables[1][0], entry.publishedDate) };
}

module.exports = {
  id: 'inner-mongolia-east',
  name: '内蒙古东部价区',
  sourceName: '内蒙古自治区发展和改革委员会',
  priceScope: '内蒙古自治区东部价区（呼伦贝尔市、兴安盟、通辽市、赤峰市、锡林郭勒盟）汽、柴油最高零售价格（元/升）；加油站实付价可能不同。',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today = chinaDate() } = {}) {
    if (typeof getText !== 'function') throw new TypeError('内蒙古东部价区：需要官方网页读取器');
    const asOf = validDate(today, '核对日期');
    const byDate = new Map();
    for (const entry of listing(await getText(LIST_URL))) {
      const prior = byDate.get(entry.publishedDate);
      if (prior && prior.url !== entry.url) throw new Error(`内蒙古东部价区：同日公告不唯一：${entry.publishedDate}`);
      byDate.set(entry.publishedDate, entry);
    }
    const recent = [...byDate.values()].filter((entry) => nextDate(entry.publishedDate) <= asOf)
      .sort((a, b) => a.publishedDate.localeCompare(b.publishedDate)).slice(-12);
    if (!recent.length) throw new Error('内蒙古东部价区：官网列表没有已生效调价公告');
    const notices = [];
    for (const entry of recent) notices.push(article(await getText(entry.url), entry));
    return notices;
  },
  article,
};
