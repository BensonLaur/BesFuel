'use strict';

const HOSTNAME = 'drc.xizang.gov.cn';
const LIST_URL = `https://${HOSTNAME}/zwgk_1941/tz/`;
const TITLE = '西藏自治区成品油销售价格调整通知';
const ARTICLE_PATH = /^\/(?:zwgk_1941\/tz|fgdt\/jggl)\/(\d{6})\/t(\d{8})_\d+\.html$/;

function validDate(value, label) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value) {
    throw new Error(`西藏阿里价区：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function officialArticleUrl(reference, base) {
  const url = new URL(reference, base);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username || url.password ||
      url.search || url.hash || !ARTICLE_PATH.test(url.pathname)) {
    throw new Error(`西藏阿里价区：公告不是预期的自治区发改委地址：${url.href}`);
  }
  return url.href;
}

function latestEntry(html) {
  const entries = [];
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*([^<]*成品油销售价格调整通知[^<]*)<\/a>/gi)];
  for (const anchor of anchors) {
    const title = anchor[2].replace(/\s+/g, '');
    if (title !== TITLE) throw new Error(`西藏阿里价区：未知油价公告标题：${title}`);
    const url = officialArticleUrl(anchor[1], LIST_URL);
    const path = new URL(url).pathname.match(ARTICLE_PATH);
    if (path[1] !== path[2].slice(0, 6)) {
      throw new Error(`西藏阿里价区：公告路径月份与日期不符：${url}`);
    }
    const pathDate = validDate(`${path[2].slice(0, 4)}-${path[2].slice(4, 6)}-${path[2].slice(6, 8)}`, '公告路径日期');
    entries.push({ url, pathDate });
  }
  if (!entries.length) throw new Error('西藏阿里价区：官网列表没有可核验油价公告或结构已变化');
  entries.sort((a, b) => b.pathDate.localeCompare(a.pathDate));
  if (entries.length > 1 && entries[0].pathDate === entries[1].pathDate) {
    throw new Error(`西藏阿里价区：最新公告日期不唯一：${entries[0].pathDate}`);
  }
  return entries[0];
}

function compact(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp);|&#(?:160|x[aA]0);/gi, '')
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function parseArticle(html, entry) {
  const text = compact(html);
  const published = text.match(/发布时间：(\d{4}-\d{2}-\d{2})/);
  if (!text.includes(TITLE) || !published) {
    throw new Error(`西藏阿里价区：公告标题或发布时间缺失：${entry.url}`);
  }
  const pageDate = validDate(published[1], '网页发布日期');
  const adjusted = text.match(/我区成品油销售价格自(\d{4})年(\d{1,2})月(\d{1,2})日24时起同步调整/);
  if (!adjusted || !text.includes('调整后的全区成品油销售价格')) {
    throw new Error(`西藏阿里价区：公告未确认调价生效日：${entry.url}`);
  }
  const publishedDate = validDate(`${adjusted[1]}-${adjusted[2].padStart(2, '0')}-${adjusted[3].padStart(2, '0')}`, '调价日期');
  const lag = Date.parse(`${entry.pathDate}T00:00:00Z`) - Date.parse(`${publishedDate}T00:00:00Z`);
  if ((pageDate !== entry.pathDate && pageDate !== publishedDate) || lag < 0 || lag > 7 * 86_400_000) {
    // 官网曾在调价四天后补发公告，允许一周内迟发但不允许日期倒置。
    throw new Error(`西藏阿里价区：公告路径、页面日期与调价日期冲突：${entry.url}`);
  }
  const starts = [...text.matchAll(/[（(]三[）)]阿里价区/g)];
  const end = text.indexOf('二、根据国家关于', starts[0]?.index ?? 0);
  if (starts.length !== 1 || end <= starts[0].index ||
      !/[（(]二[）)]昌都价区/.test(text.slice(0, starts[0].index))) {
    throw new Error(`西藏阿里价区：官方价区范围或价格分段异常：${entry.url}`);
  }
  const section = text.slice(starts[0].index, end);
  for (const grade of ['95号汽油', '92号汽油', '0号柴油']) {
    const pattern = new RegExp(`(?:^|。|阿里价区)${grade}每吨由[\\d,.]+元(?:上调|下调)为[\\d,.]+元，每升由[\\d.]+元(?:上调|下调)为[\\d.]+元`);
    if (!pattern.test(section)) {
      throw new Error(`西藏阿里价区：${grade}每升价缺失或格式变化：${entry.url}`);
    }
  }
  // 公告仍需人工核价，监测器只定位新的官方公告，避免直接覆盖已核准快照。
  return { url: entry.url, publishedDate, effectiveDate: nextDate(publishedDate),
    requiresManualPriceReview: true };
}

module.exports = {
  id: 'xizang-ngari',
  name: '西藏·阿里价区',
  sourceName: '西藏自治区发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('西藏阿里价区：需要官方 HTML 读取器');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
