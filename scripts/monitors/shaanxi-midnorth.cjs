'use strict';

const HOSTNAME = 'sndrc.shaanxi.gov.cn';
const LIST_URL = `https://${HOSTNAME}/sy/xwxx/gggg/index.html`;
const TITLE = '陕西省成品油价格调整通告';
const ARTICLE_PATH = /^\/sy\/xwxx\/gggg\/(\d{6})\/t(\d{8})_\d+\.html$/;
const IMAGE_PATH = /^\/sy\/xwxx\/gggg\/(\d{6})\/W\d+(?:_ORIGIN)?\.(?:png|jpg|jpeg)$/i;

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`陕西中北部价区：${label}无效：${value}`);
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
    throw new Error(`陕西中北部价区：${label}不是预期的省发改委地址：${url.href}`);
  }
  return url.href;
}

function latestEntry(html) {
  const entries = [];
  const oilAnchors = [...html.matchAll(/<a\s+href="\.\/\d{6}\/t\d{8}_\d+\.html">\s*[^<]*成品油价格[^<]*<\/a>/gi)];
  for (const item of html.matchAll(/<li>\s*<a href="([^"]+)">\s*([^<]+?)\s*<\/a>\s*<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>\s*<\/li>/gi)) {
    const title = item[2].trim();
    if (!title.includes('成品油价格')) continue;
    if (title !== TITLE) throw new Error(`陕西中北部价区：未知油价公告标题：${title}`);
    const publishedDate = validDate(item[3], '列表日期');
    const url = officialUrl(item[1], LIST_URL, ARTICLE_PATH, '公告');
    const path = new URL(url).pathname.match(ARTICLE_PATH);
    if (path[1] !== publishedDate.slice(0, 4) + publishedDate.slice(5, 7) ||
        path[2] !== publishedDate.replace(/-/g, '')) {
      throw new Error(`陕西中北部价区：公告路径与列表日期不符：${url}`);
    }
    entries.push({ title, publishedDate, url });
  }
  if (!entries.length || entries.length !== oilAnchors.length) {
    throw new Error('陕西中北部价区：官网列表没有可核验油价公告或结构已变化');
  }
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`陕西中北部价区：同日公告不唯一：${entries[0].publishedDate}`);
  }
  return entries[0];
}

function parseArticle(html, entry) {
  const title = html.match(/<title>\s*([^<]+?)\s*<\/title>/i)?.[1];
  const published = html.match(/发布时间：\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  if (title !== entry.title || !published ||
      validDate(published, '正文发布日期') !== entry.publishedDate) {
    throw new Error(`陕西中北部价区：公告正文标题或发布日期与列表不符：${entry.url}`);
  }
  const [year, month, day] = entry.publishedDate.split('-').map(Number);
  const plain = html.replace(/<[^>]*>/g, '').replace(/\s|\u00a0/g, '');
  if (!plain.includes(`自${year}年${month}月${day}日24时起执行`) ||
      !plain.includes(`陕西省发展和改革委员会${year}年${month}月${day}日`)) {
    throw new Error(`陕西中北部价区：公告生效日或发文落款不符：${entry.url}`);
  }
  const images = [...html.matchAll(/<img\s+src="(\.\/W\d+(?:_ORIGIN)?\.(?:png|jpg|jpeg))"/gi)];
  if (images.length !== 1) throw new Error(`陕西中北部价区：官方价格表图片数量异常：${entry.url}`);
  const imageUrl = officialUrl(images[0][1], entry.url, IMAGE_PATH, '价格表图片');
  const imageMonth = new URL(imageUrl).pathname.match(IMAGE_PATH)[1];
  if (imageMonth !== entry.publishedDate.slice(0, 4) + entry.publishedDate.slice(5, 7) ||
      !new URL(imageUrl).pathname.includes(`W0${entry.publishedDate.replace(/-/g, '')}`)) {
    throw new Error(`陕西中北部价区：价格表图片日期与公告不符：${imageUrl}`);
  }
  // 图片中的汽油价区与柴油价区各自成表；新图必须人工读中北部与“其他价区”两行。
  return { url: entry.url, publishedDate: entry.publishedDate,
    effectiveDate: nextDate(entry.publishedDate), imageUrl, requiresManualPriceReview: true };
}

module.exports = {
  id: 'shaanxi-midnorth',
  name: '陕西中北部（西安市区外）',
  sourceName: '陕西省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('陕西中北部价区：需要官方 HTML 读取器');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
