'use strict';

const HOSTNAME = 'www.klmy.gov.cn';
const LIST_URL = `https://${HOSTNAME}/search/db9694580ad74929979e1981b8c534f9?page=1&_pageSize=100&_isAgg=true&_isJson=true&_template=index&_rangeTimeGte=&_channelName=`;
const TITLE = /^(20\d{2})年(\d{1,2})月(\d{1,2})日24时起我市成品油价格按机制(?:上调|下调)$/;
const ARTICLE_PATH = /^\/klmys\/c100186\/(20\d{2})(\d{2})\/[0-9a-f]{32}\.shtml$/;

function validDate(year, month, day) {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`独山子油价公告：日期无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function officialUrl(reference, date) {
  const url = new URL(reference);
  const path = url.pathname.match(ARTICLE_PATH);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== HOSTNAME ||
      url.username || url.password || url.search || url.hash || !path ||
      `${path[1]}-${path[2]}` !== date.slice(0, 7)) {
    throw new Error(`独山子油价公告：非预期的市政府正文地址：${reference}`);
  }
  // The official search API emits HTTP links; the same article is available over HTTPS.
  url.protocol = 'https:';
  return url.href;
}

function listEntries(body) {
  let payload;
  try { payload = JSON.parse(body); } catch (_) {
    throw new Error('独山子油价公告：官网价格信息列表不是 JSON');
  }
  const results = payload?.data?.results;
  if (!Array.isArray(results) || !results.length || payload.data.channelId !== 'db9694580ad74929979e1981b8c534f9') {
    throw new Error('独山子油价公告：官网价格信息列表为空或栏目已变化');
  }
  const entries = [];
  const seen = new Set();
  for (const item of results) {
    if (!item?.title?.includes('成品油价格')) continue;
    const match = item.title.match(TITLE);
    if (!match) throw new Error(`独山子油价公告：未知调价标题：${item.title}`);
    const date = validDate(match[1], match[2], match[3]);
    if (!item.publishedTimeStr?.startsWith(`${date} `) ||
        item.channelCodeName !== 'c100186' || item.channelName !== '价格信息' || seen.has(date)) {
      throw new Error(`独山子油价公告：列表日期、栏目或公告重复：${item.title}`);
    }
    seen.add(date);
    entries.push({ title: item.title, date, url: officialUrl(item.url, date) });
  }
  if (!entries.length) throw new Error('独山子油价公告：未发现调价公告');
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

function compact(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp);|&#(?:160|x[aA]0);/gi, '')
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function parseArticle(html, entry) {
  const metadataTitle = html.match(/<meta name="ArticleTitle" content="([^"]+)"\s*\/>/i)?.[1];
  const displayTitle = html.match(/<UCAPTITLE>([^<]+)<\/UCAPTITLE>/i)?.[1];
  const postedDate = html.match(/<meta name="PubDate" content="(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}">/i)?.[1];
  if (metadataTitle !== entry.title || displayTitle !== entry.title || postedDate !== entry.date ||
      !/<meta name="ContentSource" content="市发展和改革委员会"\s*\/>/i.test(html)) {
    throw new Error(`独山子油价公告：正文标题、日期或来源与列表不符：${entry.url}`);
  }
  const content = html.match(/<UCAPCONTENT>([\s\S]*?)<\/UCAPCONTENT>/i)?.[1];
  if (!content) throw new Error('独山子油价公告：正文价格表缺失');
  const text = compact(content);
  const displayedDate = `${Number(entry.date.slice(0, 4))}年${Number(entry.date.slice(5, 7))}月${Number(entry.date.slice(8, 10))}日24时起`;
  if (!text.includes(`自${displayedDate}`) ||
      !/克拉玛依市(?:发展和改革委员会|发展改革委)/.test(text) ||
      !text.includes('克拉玛依市各加油站成品油最高零售价格表') || !text.includes('元/升') ||
      !/克拉玛依区、?白碱滩区、?乌尔禾区独山子区/.test(text)) {
    throw new Error('独山子油价公告：生效时间、单位、署名或双价区表不符');
  }
  const prices = {};
  for (const row of content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(cell => compact(cell[1]));
    const grade = /^92号汽油/.test(cells[0]) ? '92' :
      /^95号汽油/.test(cells[0]) ? '95' :
      /^0号车用柴油/.test(cells[0]) ? 'diesel' : null;
    if (!grade) continue;
    if (grade in prices || cells.length !== 6 || !/^\d{4,5}$/.test(cells[1]) ||
        !/^\d{3}(?:\.\d+)?$/.test(cells[2]) || !/^\d{1,2}\.\d{2}$/.test(cells[3]) ||
        !/^\d{3}(?:\.\d+)?$/.test(cells[4]) || !/^\d{1,2}\.\d{2}$/.test(cells[5])) {
      throw new Error(`独山子油价公告：${grade} 行或双价区列无效`);
    }
    // The government prints density in kg/m³ and tonne prices in yuan/tonne; both liter columns must reconcile.
    const mainLiter = Math.round(Number(cells[1]) * Number(cells[2]) / 10000) / 100;
    const dushanziLiter = Math.round(Number(cells[1]) * Number(cells[4]) / 10000) / 100;
    if (mainLiter !== Number(cells[3]) || dushanziLiter !== Number(cells[5])) {
      throw new Error(`独山子油价公告：${grade} 双价区升价与官方吨价、密度不符`);
    }
    prices[grade] = Number(cells[5]);
  }
  if (Object.keys(prices).length !== 3 || Object.values(prices).some(price => price < 4 || price > 20)) {
    throw new Error('独山子油价公告：缺少可信的独山子 92、95 或 0 号升价');
  }
  return {
    url: entry.url,
    publishedDate: entry.date,
    effectiveDate: nextDate(entry.date),
    prices,
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'xinjiang-dushanzi',
  name: '新疆·克拉玛依（独山子区）',
  sourceName: '克拉玛依市发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  listEntries,
  parseArticle,
  async collect({ getText, today } = {}) {
    if (typeof getText !== 'function') throw new TypeError('独山子油价公告：需要官方 HTML 读取器');
    const currentDay = today || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const entry = listEntries(await getText(LIST_URL)).find(item => nextDate(item.date) <= currentDay);
    if (!entry) throw new Error('独山子油价公告：未找到已生效的官网公告');
    return parseArticle(await getText(entry.url), entry);
  },
};
