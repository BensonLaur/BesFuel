'use strict';

const HOSTNAME = 'fgw.qinghai.gov.cn';
// 省发改委现行站点的 HTTPS 入口无响应，公告及价表由其 HTTP 入口提供。
const LIST_URL = `http://${HOSTNAME}/xwzx/tzgg/`;
const ARTICLE_PATH = /^\/xwzx\/tzgg\/(\d{6})\/t(\d{8})_\d+\.html$/;
const IMAGE_PATH = /^\/xwzx\/tzgg\/(\d{6})\/W0(\d{8})\d+\.(?:jpe?g|png)$/i;
const TITLE_PATTERN = /^我省(?:按照价格形成机制)?(?:调整|上调|下调)省内成品油最高零售价格$/;

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`青海第一价区：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function officialUrl(reference, base, pattern, label) {
  const url = new URL(reference, base);
  if (url.protocol !== 'http:' || url.hostname !== HOSTNAME || url.username || url.password ||
      url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error(`青海第一价区：${label}不是预期的省发改委地址：${url.href}`);
  }
  return url.href;
}

function latestEntry(html) {
  const entries = [];
  const oilAnchors = [...html.matchAll(/<a\s+href="[^"]+"\s+target="_blank">\s*[^<]*成品油最高零售价格\s*<\/a>/gi)];
  const itemPattern = /<li class="clearfix"><a href="([^"]+)"\s+target="_blank">\s*([^<]+?)\s*<\/a><span>\[\s*(\d{4}-\d{2}-\d{2})\]\s*<\/span>\s*<\/li>/gi;
  for (const item of html.matchAll(itemPattern)) {
    const title = item[2].replace(/\s+/g, '');
    if (!title.includes('成品油最高零售价格')) continue;
    if (!TITLE_PATTERN.test(title)) throw new Error(`青海第一价区：未知油价公告标题：${title}`);
    const publishedDate = validDate(item[3], '列表日期');
    const url = officialUrl(item[1], LIST_URL, ARTICLE_PATH, '公告');
    const path = new URL(url).pathname.match(ARTICLE_PATH);
    if (path[1] !== publishedDate.slice(0, 4) + publishedDate.slice(5, 7) ||
        path[2] !== publishedDate.replace(/-/g, '')) {
      throw new Error(`青海第一价区：公告路径与列表日期不符：${url}`);
    }
    entries.push({ title, publishedDate, url });
  }
  if (!entries.length || entries.length !== oilAnchors.length) {
    throw new Error('青海第一价区：官网列表没有可核验油价公告或结构已变化');
  }
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`青海第一价区：同日公告不唯一：${entries[0].publishedDate}`);
  }
  return entries[0];
}

function parseArticle(html, entry) {
  const title = html.match(/<h1>\s*([^<]+?)\s*<\/h1>/i)?.[1].replace(/\s+/g, '');
  const published = html.match(/发布时间：(\d{4})年(\d{2})月(\d{2})日\s+\d{2}:\d{2}/i);
  const articleDate = published && `${published[1]}-${published[2]}-${published[3]}`;
  if (title !== entry.title || !articleDate ||
      validDate(articleDate, '正文发布日期') !== entry.publishedDate) {
    throw new Error(`青海第一价区：公告正文标题或发布日期与列表不符：${entry.url}`);
  }
  const [year, month, day] = entry.publishedDate.split('-').map(Number);
  const plain = html.replace(/<[^>]*>/g, '').replace(/\s|\u00a0/g, '');
  if (!plain.includes(`我省自${year}年${month}月${day}日24时起同步调整省内各价区汽、柴油最高零售价格`) ||
      !plain.includes('青海省汽、柴油最高零售价格表')) {
    throw new Error(`青海第一价区：正文未能核实省内价格表和生效日：${entry.url}`);
  }
  const images = [...html.matchAll(/<img\s+src="(\.\/W\d+\.(?:jpe?g|png))"\s+title=/gi)];
  if (images.length !== 1) throw new Error(`青海第一价区：官方价格表图片数量异常：${entry.url}`);
  const imageUrl = officialUrl(images[0][1], entry.url, IMAGE_PATH, '价格表图片');
  const path = new URL(imageUrl).pathname.match(IMAGE_PATH);
  if (path[1] !== entry.publishedDate.slice(0, 4) + entry.publishedDate.slice(5, 7) ||
      path[2] !== entry.publishedDate.replace(/-/g, '')) {
    throw new Error(`青海第一价区：价格表图片日期与公告不符：${imageUrl}`);
  }
  // 官方以图片发布每升价；新公告必须由人核对第一价区行后才可导入。
  return { url: entry.url, publishedDate: entry.publishedDate,
    effectiveDate: nextDate(entry.publishedDate), imageUrl, requiresManualPriceReview: true };
}

module.exports = {
  id: 'qinghai-zone1',
  name: '青海第一价区',
  sourceName: '青海省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('青海第一价区：需要官方 HTML 读取器');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
