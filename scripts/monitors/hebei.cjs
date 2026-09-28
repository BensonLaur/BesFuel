'use strict';

const LIST_URL = 'https://hbdrc.hebei.gov.cn/gggs_980/';
const HOSTNAME = 'hbdrc.hebei.gov.cn';

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`河北油价公告：${label}无效：${value}`);
  }
  return value;
}

function officialUrl(reference, baseUrl, pattern, label) {
  const url = new URL(reference, baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME ||
      url.username || url.password || url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error(`河北油价公告：${label}不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function latestEntry(html) {
  const entries = [];
  for (const item of html.matchAll(/<li\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[^<]*<\/a>\s*<span\s+class="date">(\d{4}-\d{2}-\d{2})<\/span>\s*<\/li>/gi)) {
    if (!item[2].includes('成品油价格')) continue;
    if (!/^关于调整成品油价格的公告（\d{4}年第\d+号）$/.test(item[2])) {
      throw new Error(`河北油价公告：未知的公告标题：${item[2]}`);
    }
    entries.push({
      url: officialUrl(item[1], LIST_URL, /^\/gggs_980\/\d{6}\/t\d{8}_\d+\.html$/, '公告'),
      title: item[2],
      publishedDate: validDate(item[3], '列表发布日期'),
    });
  }
  if (!entries.length) throw new Error('河北油价公告：官网列表中未找到调价公告');
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`河北油价公告：同日公告不唯一：${entries[0].publishedDate}`);
  }
  return entries[0];
}

function parseArticle(html, entry) {
  const title = html.match(/<h1>\s*([^<]+)\s*<\/h1>/);
  if (!title || title[1].trim() !== entry.title) {
    throw new Error(`河北油价公告：公告标题与列表不一致：${entry.url}`);
  }
  const date = html.match(/<p\s+class="sjly13s"[\s\S]*?时间：\s*(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}[\s\S]*?<\/p>/);
  if (!date || validDate(date[1], '正文发布日期') !== entry.publishedDate) {
    throw new Error(`河北油价公告：发布日期与列表不一致：${entry.url}`);
  }
  const start = html.indexOf('id="zoom"');
  const end = html.indexOf('class="rgtbar_erji_link"', start);
  if (start < 0 || end < 0) throw new Error(`河北油价公告：缺少公告正文：${entry.url}`);
  const images = [...html.slice(start, end).matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)];
  if (images.length !== 1) {
    throw new Error(`河北油价公告：价格公告图片数量异常：${images.length}`);
  }
  const articleDirectory = new URL('.', entry.url).pathname;
  const imageUrl = officialUrl(
    images[0][1], entry.url,
    new RegExp(`^${articleDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}W[0-9]+\\.(?:png|jpg|jpeg)$`, 'i'),
    '公告图片',
  );
  return {
    url: entry.url,
    publishedDate: entry.publishedDate,
    imageUrl,
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'hebei',
  name: '河北',
  sourceName: '河北省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText }) {
    if (typeof getText !== 'function') throw new TypeError('河北油价公告：getText 必须为函数');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
