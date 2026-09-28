'use strict';

const HOSTNAME = 'fgw.hunan.gov.cn';
const LIST_URL = `https://${HOSTNAME}/fgw/xxgk_70899/gzdtf/gzdt/newxxgklist.html`;
const TITLE = /^关于调整成品油价格的通知[（(](\d{4})年(\d{1,2})月(\d{1,2})日[）)]$/;
const ARTICLE_PATH = /^\/fgw\/(?:xxgk_70899\/gzdtf\/gzdt|jggb11)\/(\d{6})\/t(\d{8})_(\d+)\.html$/;

function compact(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp|#160|#x[aA]0);/gi, '')
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`湖南油价公告：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function officialArticle(reference, titleDate) {
  const url = new URL(reference, LIST_URL);
  const match = url.pathname.match(ARTICLE_PATH);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.port ||
      url.username || url.password || url.search || url.hash || !match ||
      match[1] !== match[2].slice(0, 6)) {
    throw new Error(`湖南油价公告：非预期官方公告地址：${url.href}`);
  }
  const pathDate = validDate(`${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6)}`, '公告路径日期');
  if (pathDate !== titleDate) throw new Error(`湖南油价公告：标题与路径日期不一致：${url.href}`);
  return { url: url.href, publishedDate: titleDate, articleId: match[3] };
}

function entriesFromList(html) {
  const entries = [];
  for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi)) {
    const title = compact(anchor[2]);
    if (!title.startsWith('关于调整成品油价格的通知')) continue;
    const titleMatch = title.match(TITLE);
    if (!titleMatch) throw new Error(`湖南油价公告：未知油价公告标题：${title}`);
    const date = validDate(`${titleMatch[1]}-${titleMatch[2].padStart(2, '0')}-${titleMatch[3].padStart(2, '0')}`, '标题日期');
    const href = anchor[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) throw new Error(`湖南油价公告：缺少公告地址：${title}`);
    entries.push(officialArticle(href.replace(/&amp;/gi, '&'), date));
  }
  if (!entries.length) throw new Error('湖南油价公告：官网列表中没有可核验的调价公告');
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`湖南油价公告：最新公告日期不唯一：${entries[0].publishedDate}`);
  }
  return entries;
}

function officialAttachment(reference, entry) {
  const url = new URL(reference, entry.url);
  const article = new URL(entry.url);
  const prefix = article.pathname.slice(0, article.pathname.lastIndexOf('/') + 1);
  const expected = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${entry.articleId}/files/[a-f0-9]{32}\\.xls$`);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.port ||
      url.username || url.password || url.search || url.hash || !expected.test(url.pathname)) {
    throw new Error(`湖南油价公告：XLS 附件不是该公告的官网文件：${url.href}`);
  }
  return url.href;
}

function inspectArticle(html, entry) {
  const text = compact(html);
  const [year, month, day] = entry.publishedDate.split('-');
  const title = `关于调整成品油价格的通知(${year}年${Number(month)}月${Number(day)}日)`;
  if (!text.includes(title) || !text.includes(`发布日期：${entry.publishedDate}`) ||
      !text.includes('湖南省发展和改革委员会') ||
      !text.includes(`汽、柴油价格自${year}年${Number(month)}月${Number(day)}日24时起执行`) ||
      !text.includes('汽、柴油零售仍实行最高价格管理') ||
      !text.includes('最高零售价格见附件') ||
      !text.includes('附件：湖南省成品油销售价格表')) {
    throw new Error(`湖南油价公告：标题、日期、价格性质或附件说明不符：${entry.url}`);
  }
  const attachments = [...html.matchAll(/<a\b([^>]*)>([\s\S]{0,100}?)<\/a>/gi)]
    .filter(anchor => compact(anchor[2]) === '销售价格表.xls');
  if (attachments.length !== 1) throw new Error(`湖南油价公告：XLS 价格表链接缺失或重复：${entry.url}`);
  const href = attachments[0][1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!href) throw new Error(`湖南油价公告：XLS 价格表没有地址：${entry.url}`);
  // 正文只给每吨调整额；链接存在不等于已读取 XLS 内的 92/95/0 元/升价格。
  return { url: entry.url, publishedDate: entry.publishedDate,
    effectiveDate: nextDate(entry.publishedDate),
    attachmentUrl: officialAttachment(href.replace(/&amp;/gi, '&'), entry),
    requiresManualLiterReview: true };
}

function chinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = {
  id: 'hunan',
  name: '湖南',
  sourceName: '湖南省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today } = {}) {
    if (typeof getText !== 'function') throw new TypeError('湖南油价公告：需要官方 HTML 读取器');
    const day = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today ?? chinaDate(), '今天');
    for (const entry of entriesFromList(await getText(LIST_URL)).slice(0, 6)) {
      if (nextDate(entry.publishedDate) <= day) return inspectArticle(await getText(entry.url), entry);
    }
    throw new Error('湖南油价公告：官网列表没有已生效的调价公告');
  },
};
