'use strict';

const HOSTNAME = 'yndrc.yn.gov.cn';
const LIST_URL = `https://${HOSTNAME}/html/fagaishuju/jiagegongbu/`;
const TITLE = '云南省成品油价格按机制调整';
const ARTICLE_PATH = /^\/html\/(\d{4})\/[a-z]+_(\d{4})\/\d+\.html$/;
const PDF_PATH = /^\/uploadfile\/s2\/(\d{4})\/(\d{4})\/(\d{8})\d{9}\.pdf$/;

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`云南第五价区：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function officialUrl(reference, base, pattern, label) {
  const url = new URL(reference, base);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username || url.password ||
      url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error(`云南第五价区：${label}不是预期的省发改委地址：${url.href}`);
  }
  return url.href;
}

function latestEntry(html) {
  const entries = [];
  const oilAnchors = [...html.matchAll(/<a\b[^>]*>[^<]*成品油价格[^<]*<\/a>/gi)];
  for (const item of html.matchAll(/<li>\s*<a href="([^"]+)">([^<]+)<\/a>\s*<span>(\d{4}-\d{2}-\d{2})<\/span>\s*<\/li>/gi)) {
    const title = item[2].trim();
    if (!title.includes('成品油价格')) continue;
    if (title !== TITLE) throw new Error(`云南第五价区：未知油价公告标题：${title}`);
    const publishedDate = validDate(item[3], '列表日期');
    const url = officialUrl(item[1], LIST_URL, ARTICLE_PATH, '公告');
    const path = new URL(url).pathname.match(ARTICLE_PATH);
    if (path[1] !== publishedDate.slice(0, 4) ||
        path[2] !== publishedDate.slice(5, 7) + publishedDate.slice(8, 10)) {
      throw new Error(`云南第五价区：公告路径与列表日期不符：${url}`);
    }
    entries.push({ title, publishedDate, url });
  }
  // 价格栏目同时列出生活物价；这里要求所有油价标题都被解析，避免版式变化时沿用旧公告。
  if (!entries.length || oilAnchors.length !== entries.length) {
    throw new Error('云南第五价区：官网列表没有可核验油价公告或结构已变化');
  }
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`云南第五价区：同日公告不唯一：${entries[0].publishedDate}`);
  }
  return entries[0];
}

function parseArticle(html, entry) {
  const title = html.match(/<meta name="ArticleTitle" content="([^"]+)"/i)?.[1];
  const published = html.match(/<meta name="PubDate" content="(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}"/i)?.[1];
  if (title !== entry.title || !published ||
      validDate(published, '正文发布日期') !== entry.publishedDate) {
    throw new Error(`云南第五价区：公告正文标题或发布日期与列表不符：${entry.url}`);
  }
  const [year, month, day] = entry.publishedDate.split('-').map(Number);
  const plain = html.replace(/<[^>]*>/g, '').replace(/\s|\u00a0/g, '');
  if (!plain.includes(`自${month}月${day}日24时起`) ||
      !plain.includes(`云南省各地区的汽、柴油最高零售价格见附表`) ||
      !plain.includes(`${year}年${month}月${day}日`)) {
    throw new Error(`云南第五价区：公告缺少生效日或省内价格表说明：${entry.url}`);
  }
  const attachments = [...html.matchAll(/<a href="([^"]+\.pdf)">云南省各地区汽、柴油最高零售价格表<\/a>/gi)];
  if (attachments.length !== 1) {
    throw new Error(`云南第五价区：官方 PDF 价格表数量异常：${entry.url}`);
  }
  const pdfUrl = officialUrl(attachments[0][1], entry.url, PDF_PATH, '价格表 PDF');
  const path = new URL(pdfUrl).pathname.match(PDF_PATH);
  if (path[1] !== String(year) || path[2] !== String(month).padStart(2, '0') + String(day).padStart(2, '0') ||
      path[3] !== entry.publishedDate.replace(/-/g, '')) {
    throw new Error(`云南第五价区：PDF 日期与公告不符：${pdfUrl}`);
  }
  return { url: entry.url, publishedDate: entry.publishedDate,
    effectiveDate: nextDate(entry.publishedDate), pdfUrl, requiresManualPriceReview: true };
}

module.exports = {
  id: 'yunnan-zone5',
  name: '云南第五价区',
  sourceName: '云南省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('云南第五价区：需要官方 HTML 读取器');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
