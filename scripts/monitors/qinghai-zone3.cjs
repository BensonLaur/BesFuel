'use strict';

const HOSTNAME = 'fgw.qinghai.gov.cn';
const LIST_URLS = [
  `http://${HOSTNAME}/xwzx/tzgg/`,
  `http://${HOSTNAME}/sjfb/jgdt/`,
];
const TITLE = /^我省(?:按照价格形成机制)?(?:调整|上调|下调)省内成品油最高零售价格$/;
const ARTICLE_PATH = /^\/(?:xwzx\/tzgg|sjfb\/jgdt)\/\d{6}\/t\d{8}_\d+\.html$/;

function validDate(value, label) {
  const date = new Date(`${value}T00:00:00Z`);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`青海第三价区：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function officialUrl(reference, base, pathname, label) {
  const url = new URL(reference, base);
  // 青海省发改委当前只开放 HTTP；限定唯一官方主机和公告路径。
  if (url.protocol !== 'http:' || url.hostname !== HOSTNAME || url.username ||
      url.password || url.search || url.hash || !pathname.test(url.pathname)) {
    throw new Error(`青海第三价区：${label}不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function entries(html, listUrl) {
  const list = /<ul class=" clearfix con-item listcontent_ul overflows">([\s\S]*?)<\/ul>/.exec(html)?.[1];
  if (!list) throw new Error(`青海第三价区：官网公告列表结构异常：${listUrl}`);
  const rows = [...list.matchAll(/<li class="clearfix"><a href="([^"]+)"\s*target="_blank">\s*([^<]+)\s*<\/a><span>\[\s*(\d{4}-\d{2}-\d{2})\]/g)];
  if (!rows.length) throw new Error(`青海第三价区：官网公告列表为空：${listUrl}`);
  const found = [];
  let previousDate = '';
  for (const row of rows) {
    const publishedDate = validDate(row[3], '列表发布日期');
    if (previousDate && publishedDate > previousDate) {
      throw new Error(`青海第三价区：官网公告列表日期顺序异常：${listUrl}`);
    }
    previousDate = publishedDate;
    const title = row[2].trim();
    if (!title.includes('成品油')) continue;
    if (!TITLE.test(title)) throw new Error(`青海第三价区：未知的调价标题：${title}`);
    found.push({ title, publishedDate, effectiveDate: nextDate(publishedDate),
      url: officialUrl(row[1], listUrl, ARTICLE_PATH, '公告') });
  }
  return found;
}

function latestEntry(pages, today) {
  const all = pages.flatMap((html, index) => entries(html, LIST_URLS[index]));
  const effective = all.filter(entry => entry.effectiveDate <= today)
    .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (!effective.length) throw new Error('青海第三价区：没有已生效的官网调价公告');
  // 同日双栏目刊载时采用通知公告；价格动态可补足某栏目的漏登期。
  return effective[0];
}

function inspectArticle(html, entry) {
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const [year, month, day] = entry.publishedDate.split('-');
  const publishPattern = new RegExp(`${entry.title}\\s+发布时间：${year}年${month}月${day}日`);
  const effectivePattern = new RegExp(`自${year}年${Number(month)}月${Number(day)}日24时起`);
  if (!publishPattern.test(visible) || !effectivePattern.test(visible)) {
    throw new Error(`青海第三价区：公告标题、发布日期或生效时间与列表不符：${entry.url}`);
  }
  if (!visible.includes('青海省汽、柴油最高零售价格表') ||
      !visible.includes('省内各价区汽、柴油最高零售价格')) {
    throw new Error(`青海第三价区：公告缺少省内价区价格表：${entry.url}`);
  }
  const imageRefs = [...new Set([...html.matchAll(/<img\b[^>]*src="([^"]*W020\d{18}\.(?:png|jpe?g))"/gi)]
    .map(match => match[1]))];
  if (imageRefs.length > 1) throw new Error(`青海第三价区：价表图片重复：${entry.url}`);
  if (!imageRefs.length) {
    if (!/<table\b/i.test(html) || !visible.includes('三价区')) {
      throw new Error(`青海第三价区：公告中未发现价表图片或 HTML 表格：${entry.url}`);
    }
    return { ...entry, tableFormat: 'html', requiresManualLiterReview: true };
  }
  const imagePath = /^\/(?:xwzx\/tzgg|sjfb\/jgdt)\/\d{6}\/W020\d{18}\.(?:png|jpe?g)$/i;
  return { ...entry, imageUrl: officialUrl(imageRefs[0], entry.url, imagePath, '价表图片'),
    requiresManualLiterReview: true };
}

function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = {
  id: 'qinghai-zone3',
  name: '青海·第三价区',
  sourceName: '青海省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, getBuffer, today } = {}) {
    if (typeof getText !== 'function' || typeof getBuffer !== 'function') {
      throw new TypeError('青海第三价区：需要官网文本和图片读取函数');
    }
    const day = validDate(today instanceof Date ? today.toISOString().slice(0, 10) :
      today ?? currentChinaDate(), '今天');
    const pages = await Promise.all(LIST_URLS.map(url => getText(url)));
    const entry = latestEntry(pages, day);
    const result = inspectArticle(await getText(entry.url), entry);
    if (result.imageUrl) {
      const bytes = (await getBuffer(result.imageUrl))?.buffer;
      const png = bytes?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
      const jpeg = bytes?.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
      if (!Buffer.isBuffer(bytes) || bytes.length < 2048 || (!png && !jpeg)) {
        throw new Error(`青海第三价区：官方价表图片内容异常：${result.imageUrl}`);
      }
    }
    return result;
  },
};
