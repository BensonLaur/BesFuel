'use strict';

const HOSTNAME = 'fgw.guizhou.gov.cn';
const LIST_URL = `https://${HOSTNAME}/fggz/tzgg/index.html`;
const ARTICLE_PATH = /^\/fggz\/tzgg\/(\d{6})\/t(\d{8})_\d+\.html$/;
const IMAGE_PATH = /^\/fggz\/tzgg\/\d{6}\/W\d+(?:_ORIGIN)?\.(?:png|jpg|jpeg)$/i;
const TITLE = /^(\d{4})年(\d{1,2})月(\d{1,2})日24时起贵州成品油价格调整$/;

function date(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`贵州第二价区：${label}无效：${value}`);
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
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME ||
      url.username || url.password || url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error(`贵州第二价区：${label}不是预期的省发改委地址：${url.href}`);
  }
  return url.href;
}

function titleDate(value) {
  const match = value?.match(TITLE);
  if (!match) throw new Error(`贵州第二价区：未知公告标题：${value}`);
  return date(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, '标题日期');
}

function latestEntry(html) {
  const matches = [];
  for (const item of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const anchor = item[1].match(/<a\b([^>]*)>/i);
    if (!anchor) continue;
    const title = anchor[1].match(/\btitle="([^"]+)"/i)?.[1];
    if (!title?.includes('贵州成品油价格')) continue;
    const titleDay = titleDate(title);
    const href = anchor[1].match(/\bhref="([^"]+)"/i)?.[1];
    if (!href) throw new Error(`贵州第二价区：公告缺少链接：${title}`);
    const url = officialUrl(href, LIST_URL, ARTICLE_PATH, '公告');
    const pathDay = new URL(url).pathname.match(ARTICLE_PATH)[2];
    if (pathDay !== titleDay.replace(/-/g, '')) {
      throw new Error(`贵州第二价区：公告地址与标题日期不符：${url}`);
    }
    const published = item[1].match(/<span\b[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i)?.[1];
    if (!published || date(published, '列表日期') !== titleDay) {
      throw new Error(`贵州第二价区：公告列表日期与标题不符：${url}`);
    }
    matches.push({ title, publishedDate: published, url });
  }
  if (!matches.length) throw new Error('贵州第二价区：官方列表中没有调价公告');
  matches.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (matches.length > 1 && matches[0].publishedDate === matches[1].publishedDate) {
    throw new Error(`贵州第二价区：同日调价公告不唯一：${matches[0].publishedDate}`);
  }
  return matches[0];
}

function parseArticle(html, entry) {
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i)?.[1];
  if (title !== entry.title) throw new Error(`贵州第二价区：公告标题与列表不符：${entry.url}`);
  const published = html.match(/<meta\s+name="PubDate"\s+content="(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}"/i)?.[1];
  if (!published || date(published, '正文发布日期') !== entry.publishedDate) {
    throw new Error(`贵州第二价区：公告发布日期与列表不符：${entry.url}`);
  }
  if (!html.includes('贵州省各价区汽油销售价格表') ||
      !html.includes('贵州省各价区柴油')) {
    throw new Error(`贵州第二价区：公告未明确标注汽油及柴油附表：${entry.url}`);
  }
  const images = [...html.matchAll(/<img\b[^>]*\bsrc="(\.\/W\d+(?:_ORIGIN)?\.(?:png|jpg|jpeg))"/gi)];
  if (images.length !== 2) {
    throw new Error(`贵州第二价区：公告价格表图片数量异常：${images.length}`);
  }
  const imageUrls = images.map((image) =>
    officialUrl(image[1], entry.url, IMAGE_PATH, '价格表图片'));
  if (imageUrls[0] === imageUrls[1]) {
    throw new Error(`贵州第二价区：汽柴油图片重复：${entry.url}`);
  }
  const expectedImagePrefix = `/fggz/tzgg/${entry.publishedDate.slice(0, 7).replace('-', '')}/W0${entry.publishedDate.replace(/-/g, '')}`;
  if (imageUrls.some((url) => !new URL(url).pathname.startsWith(expectedImagePrefix))) {
    throw new Error(`贵州第二价区：价格表图片日期与公告不符：${entry.url}`);
  }
  return {
    url: entry.url,
    publishedDate: entry.publishedDate,
    effectiveDate: nextDate(entry.publishedDate),
    imageUrls,
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'guizhou-zone2',
  name: '贵州第二价区',
  sourceName: '贵州省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('贵州第二价区：getText 必须为函数');
    const entry = latestEntry(await getText(LIST_URL));
    // 附表是图片；发现新公告后要求逐格核价，不能把上一期价格当作新价。
    return parseArticle(await getText(entry.url), entry);
  },
};
