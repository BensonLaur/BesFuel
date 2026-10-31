'use strict';

const { chinaDate } = require('../update-regions.cjs');

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
  if (url.protocol !== 'http:' || url.hostname !== HOSTNAME || url.port || url.username || url.password ||
      url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error(`青海第一价区：${label}不是预期的省发改委地址：${url.href}`);
  }
  return url.href;
}

function inspectUploadPath(url, pattern, label) {
  const [, directory, stamp] = new URL(url).pathname.match(pattern);
  validDate(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6)}`, `${label}文件日期`);
  if (directory !== stamp.slice(0, 6)) throw new Error(`青海第一价区：${label}目录与文件日期不符：${url}`);
}

function latestEntry(html, today) {
  const entries = [];
  const oilAnchors = [...html.matchAll(/<a\s+href="[^"]+"\s+target="_blank">\s*[^<]*成品油最高零售价格\s*<\/a>/gi)];
  const itemPattern = /<li class="clearfix"><a href="([^"]+)"\s+target="_blank">\s*([^<]+?)\s*<\/a><span>\[\s*(\d{4}-\d{2}-\d{2})\]\s*<\/span>\s*<\/li>/gi;
  for (const item of html.matchAll(itemPattern)) {
    const title = item[2].replace(/\s+/g, '');
    if (!title.includes('成品油最高零售价格')) continue;
    if (!TITLE_PATTERN.test(title)) throw new Error(`青海第一价区：未知油价公告标题：${title}`);
    const publishedDate = validDate(item[3], '列表日期');
    const url = officialUrl(item[1], LIST_URL, ARTICLE_PATH, '公告');
    // 官网可能次日重新上传，文件日期不能充当公告发布日期。
    inspectUploadPath(url, ARTICLE_PATH, '公告');
    entries.push({ title, publishedDate, url });
  }
  if (!entries.length || entries.length !== oilAnchors.length) {
    throw new Error('青海第一价区：官网列表没有可核验油价公告或结构已变化');
  }
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`青海第一价区：同日公告不唯一：${entries[0].publishedDate}`);
  }
  const effective = entries.find(entry => nextDate(entry.publishedDate) <= today);
  if (!effective) throw new Error('青海第一价区：没有已生效的官方油价公告');
  return effective;
}

function parseArticle(html, entry) {
  const title = html.match(/<h1>\s*([^<]+?)\s*<\/h1>/i)?.[1].replace(/\s+/g, '');
  const published = html.match(/发布时间：(\d{4})年(\d{2})月(\d{2})日\s+\d{2}:\d{2}/i);
  const articleDate = published && `${published[1]}-${published[2]}-${published[3]}`;
  if (title !== entry.title || !/来源：价格处(?:提供|供稿)/.test(html) || !articleDate ||
      validDate(articleDate, '正文发布日期') !== entry.publishedDate) {
    throw new Error(`青海第一价区：公告正文标题、来源或发布日期与列表不符：${entry.url}`);
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
  inspectUploadPath(imageUrl, IMAGE_PATH, '价格表图片');
  if (new URL(imageUrl).pathname.slice(0, new URL(imageUrl).pathname.lastIndexOf('/')) !==
      new URL(entry.url).pathname.slice(0, new URL(entry.url).pathname.lastIndexOf('/'))) {
    throw new Error(`青海第一价区：价格表图片不在公告目录：${imageUrl}`);
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
  async collect({ getText, today = chinaDate() } = {}) {
    if (typeof getText !== 'function') throw new TypeError('青海第一价区：需要官方 HTML 读取器');
    const day = validDate(today instanceof Date ? chinaDate(today) : today, '今天');
    const entry = latestEntry(await getText(LIST_URL), day);
    return parseArticle(await getText(entry.url), entry);
  },
};
