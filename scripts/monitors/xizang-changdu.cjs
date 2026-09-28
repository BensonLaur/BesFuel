'use strict';

const HOSTNAME = 'drc.xizang.gov.cn';
const LIST_URL = `https://${HOSTNAME}/zwgk_1941/tz/`;
const TITLE = '西藏自治区成品油销售价格调整通知';
const ARTICLE_PATH = /^\/(?:zwgk_1941\/tz|fgdt\/jggl)\/(\d{6})\/t(\d{8})_\d+\.html$/;
const DAY = 86_400_000;

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`西藏昌都价区：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}

function chinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function officialArticleUrl(reference) {
  const url = new URL(reference, LIST_URL);
  const path = url.pathname.match(ARTICLE_PATH);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.port || url.username ||
      url.password || url.search || url.hash || !path || path[1] !== path[2].slice(0, 6)) {
    throw new Error(`西藏昌都价区：公告不是预期的自治区发改委地址：${url.href}`);
  }
  const pathDate = validDate(`${path[2].slice(0, 4)}-${path[2].slice(4, 6)}-${path[2].slice(6)}`, '公告路径日期');
  return { url: url.href, pathDate };
}

function entriesFromList(html) {
  const entries = [];
  for (const anchor of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const title = anchor[2].replace(/<[^>]*>|[\s\u00a0\u3000]/g, '');
    if (title !== TITLE) {
      if (/成品油(?:销售)?价格/.test(title)) {
        throw new Error(`西藏昌都价区：官网出现未知油价公告标题：${title}`);
      }
      continue;
    }
    entries.push(officialArticleUrl(anchor[1]));
  }
  if (!entries.length) throw new Error('西藏昌都价区：官网列表没有可核验油价公告或结构已变化');
  entries.sort((a, b) => b.pathDate.localeCompare(a.pathDate));
  if (entries.length > 1 && entries[0].pathDate === entries[1].pathDate) {
    throw new Error(`西藏昌都价区：最新公告路径日期不唯一：${entries[0].pathDate}`);
  }
  return entries;
}

function compact(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp);|&#(?:160|x[aA]0);/gi, '')
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function parseArticle(html, entry) {
  const text = compact(html);
  const published = text.match(/发布时间：(\d{4}-\d{2}-\d{2})来源：([^\n]+?)(?=\d{1,2}月\d{1,2}日|我区成品油销售价格自|一、调整后的全区成品油销售价格)/);
  if (!text.includes(TITLE) || !published || !/价格处/.test(published[2])) {
    throw new Error(`西藏昌都价区：公告标题、来源或网页发布日期缺失：${entry.url}`);
  }
  const pageDate = validDate(published[1], '网页发布日期');
  const adjustment = text.match(/我区成品油销售价格自(\d{4})年(\d{1,2})月(\d{1,2})日24时起同步调整/);
  if (!adjustment || !text.includes('调整后的全区成品油销售价格')) {
    throw new Error(`西藏昌都价区：公告未确认调价生效日：${entry.url}`);
  }
  const publishedDate = validDate(`${adjustment[1]}-${adjustment[2].padStart(2, '0')}-${adjustment[3].padStart(2, '0')}`, '公告正文署期');
  const lag = Date.parse(`${entry.pathDate}T00:00:00Z`) - Date.parse(`${publishedDate}T00:00:00Z`);
  if ((pageDate !== entry.pathDate && pageDate !== publishedDate) || lag < 0 || lag > 7 * DAY) {
    // 2026-06-18 公告在 06-22 才上站，正文署期和实际执行时间仍是 06-18 24 时。
    throw new Error(`西藏昌都价区：公告路径、网页日期与正文调价日期冲突：${entry.url}`);
  }
  const lhasa = text.search(/[（(]一[）)]拉萨价区[（(]包括拉萨、日喀则、山南、林芝、那曲[）)]/);
  const start = text.search(/[（(]二[）)]昌都价区/);
  const end = text.search(/[（(]三[）)]阿里价区/);
  if (lhasa < 0 || start <= lhasa || end <= start) {
    throw new Error(`西藏昌都价区：官方三价区及昌都价格分段异常：${entry.url}`);
  }
  const section = text.slice(start, end);
  for (const grade of ['95号汽油', '92号汽油', '0号柴油']) {
    // 只确认昌都段的元/升新价存在；官网历史文本有数字中夹空格的排版。
    const pattern = new RegExp(`${grade}每吨由[\\d,.]+元(?:上调|下调)为[\\d,.]+元，每升由[\\d.]+元(?:上调|下调)为[\\d.]+元`);
    if (!pattern.test(section)) throw new Error(`西藏昌都价区：${grade}每升价缺失或格式变化：${entry.url}`);
  }
  if (!/此次(?:上调|下调)后的价格为最高零售价格/.test(text)) {
    throw new Error(`西藏昌都价区：最高零售价格性质未确认：${entry.url}`);
  }
  return { url: entry.url, publishedDate, effectiveDate: nextDate(publishedDate),
    requiresManualPriceReview: true };
}

module.exports = {
  id: 'xizang-changdu',
  name: '西藏昌都价区',
  sourceName: '西藏自治区发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today } = {}) {
    if (typeof getText !== 'function') throw new TypeError('西藏昌都价区：需要官方 HTML 读取器');
    const day = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today ?? chinaDate(), '今天');
    for (const entry of entriesFromList(await getText(LIST_URL)).slice(0, 6)) {
      const result = parseArticle(await getText(entry.url), entry);
      if (result.effectiveDate <= day) return result;
    }
    throw new Error('西藏昌都价区：官网首页没有已生效的成品油调价公告');
  },
};
