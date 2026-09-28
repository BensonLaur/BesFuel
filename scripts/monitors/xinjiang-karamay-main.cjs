'use strict';

const HOSTNAME = 'www.klmy.gov.cn';
const LIST_URL = `https://${HOSTNAME}/search/db9694580ad74929979e1981b8c534f9?page=1&_pageSize=30&_isAgg=true&_isJson=true&_template=index&_rangeTimeGte=&_channelName=`;
const TITLE = /^(20\d{2})年(\d{1,2})月(\d{1,2})日24时起我市成品油价格按机制(上调|下调)$/;
const ARTICLE_PATH = /^\/klmys\/c100186\/(20\d{2})(\d{2})\/[0-9a-f]{32}\.shtml$/;

function dateFromParts(year, month, day) {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`克拉玛依油价公告：日期无效：${value}`);
  }
  return value;
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function officialUrl(reference, date) {
  const url = new URL(reference);
  const path = url.pathname.match(ARTICLE_PATH);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== HOSTNAME ||
      url.username || url.password || url.search || url.hash || !path ||
      `${path[1]}-${path[2]}` !== date.slice(0, 7)) {
    throw new Error(`克拉玛依油价公告：非预期的市政府正文地址：${reference}`);
  }
  // The government list emits http links; read the same official article over HTTPS.
  url.protocol = 'https:';
  return url.href;
}

function latestEntry(body, today) {
  let payload;
  try { payload = JSON.parse(body); } catch (_) {
    throw new Error('克拉玛依油价公告：官网列表不是 JSON');
  }
  const results = payload?.data?.results;
  if (!Array.isArray(results) || !results.length) {
    throw new Error('克拉玛依油价公告：官网价格信息列表为空或结构已变化');
  }
  const entries = [];
  for (const item of results) {
    if (!item?.title?.includes('成品油价格')) continue;
    const title = item.title.match(TITLE);
    if (!title) throw new Error(`克拉玛依油价公告：未知调价标题：${item.title}`);
    const date = dateFromParts(title[1], title[2], title[3]);
    if (!item.publishedTimeStr?.startsWith(`${date} `) ||
        item.channelCodeName !== 'c100186' || item.channelName !== '价格信息') {
      throw new Error(`克拉玛依油价公告：列表日期或栏目不符：${item.title}`);
    }
    entries.push({ title: item.title, date, url: officialUrl(item.url, date) });
  }
  if (!entries.length) throw new Error('克拉玛依油价公告：未发现调价公告');
  entries.sort((a, b) => b.date.localeCompare(a.date));
  if (entries.length > 1 && entries[0].date === entries[1].date) {
    throw new Error(`克拉玛依油价公告：同日公告不唯一：${entries[0].date}`);
  }
  const latest = entries.find(entry => nextDate(entry.date) <= today);
  if (!latest) throw new Error('克拉玛依油价公告：未找到已生效的官网公告');
  return latest;
}

function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function cellText(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&ensp;|&nbsp;|&#160;/gi, '').replace(/\s|\u00a0/g, '');
}

function parsePrices(content) {
  const text = cellText(content);
  if (!text.includes('克拉玛依市各加油站成品油最高零售价格表') ||
      !text.includes('元/升') || !text.includes('克拉玛依区、白碱滩区乌尔禾区') ||
      !text.includes('独山子区')) {
    throw new Error('克拉玛依油价公告：升价表、单位或适用区缺失');
  }
  const prices = {};
  for (const row of content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(match => cellText(match[1]));
    const grade = /^92号汽油/.test(cells[0]) ? '92' :
      /^95号汽油/.test(cells[0]) ? '95' :
      /^0号车用柴油/.test(cells[0]) ? 'diesel' : null;
    if (!grade) continue;
    if (grade in prices || cells.length !== 6 || !/^\d{4,5}$/.test(cells[1]) ||
        !/^\d{3}(?:\.\d+)?$/.test(cells[2]) ||
        !/^\d{1,2}\.\d{2}$/.test(cells[3]) ||
        !/^\d{3}(?:\.\d+)?$/.test(cells[4]) ||
        !/^\d{1,2}\.\d{2}$/.test(cells[5])) {
      throw new Error(`克拉玛依油价公告：${grade} 价格表列无效`);
    }
    const expected = Math.round(Number(cells[1]) * Number(cells[2]) / 10000) / 100;
    if (expected !== Number(cells[3])) {
      throw new Error(`克拉玛依油价公告：${grade} 市区升价与官方吨价、密度不符`);
    }
    prices[grade] = Number(cells[3]);
  }
  if (Object.keys(prices).length !== 3 ||
      Object.values(prices).some(value => value < 4 || value > 20)) {
    throw new Error('克拉玛依油价公告：缺少可信的 92、95 或 0 号升价');
  }
  return prices;
}

function parseArticle(html, entry) {
  const metadataTitle = html.match(/<meta name="ArticleTitle" content="([^"]+)"\s*\/>/i)?.[1];
  const displayTitle = html.match(/<UCAPTITLE>([^<]+)<\/UCAPTITLE>/i)?.[1];
  const postedDate = html.match(/<meta name="PubDate" content="(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}">/i)?.[1];
  if (metadataTitle !== entry.title || displayTitle !== entry.title ||
      postedDate !== entry.date ||
      !/<meta name="ContentSource" content="市发展和改革委员会"\s*\/>/i.test(html)) {
    throw new Error(`克拉玛依油价公告：正文标题、日期或来源与列表不符：${entry.url}`);
  }
  const content = html.match(/<UCAPCONTENT>([\s\S]*?)<\/UCAPCONTENT>/i)?.[1];
  if (!content) throw new Error('克拉玛依油价公告：正文价格表缺失');
  const text = cellText(content);
  if (!text.includes(`自${Number(entry.date.slice(0, 4))}年${Number(entry.date.slice(5, 7))}月${Number(entry.date.slice(8, 10))}日24时起`) ||
      !text.includes('克拉玛依市发展和改革委员会')) {
    throw new Error('克拉玛依油价公告：正文生效时间或署名不符');
  }
  return {
    url: entry.url,
    publishedDate: entry.date,
    effectiveDate: nextDate(entry.date),
    prices: parsePrices(content),
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'xinjiang-karamay-main',
  name: '新疆·克拉玛依（克拉玛依、白碱滩、乌尔禾）',
  sourceName: '克拉玛依市发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today } = {}) {
    if (typeof getText !== 'function') throw new TypeError('克拉玛依油价公告：需要官方 HTML 读取器');
    const day = today || currentChinaDate();
    dateFromParts(day.slice(0, 4), day.slice(5, 7), day.slice(8, 10));
    const entry = latestEntry(await getText(LIST_URL), day);
    return parseArticle(await getText(entry.url), entry);
  },
};
