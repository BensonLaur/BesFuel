'use strict';

const HOSTNAME = 'sndrc.shaanxi.gov.cn';
const LIST_URL = `https://${HOSTNAME}/zjww/jgcs/csxx/jgc/index_186.html`;
const ANNOUNCEMENT_TITLE = '陕西省成品油价格调整通告';
const ARTICLE_PATH = /^\/zjww\/jgcs\/csxx\/jgc\/(\d{6})\/t(\d{8})_\d+\.html$/;

function validDate(value, label) {
  const date = new Date(`${value}T00:00:00Z`);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`陕西西安市区油价：${label}无效：${value}`);
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
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username ||
      url.password || url.search || url.hash || !pathname.test(url.pathname)) {
    throw new Error(`陕西西安市区油价：${label}不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function latestEntry(html, today) {
  const list = /<ul class="rightList">([\s\S]*?)<\/ul>/.exec(html)?.[1];
  if (!list) throw new Error('陕西西安市区油价：官网价格处列表结构异常');
  const rows = [...list.matchAll(/<li>\s*<a href="([^"]+)">\s*([^<]+)\s*<\/a>\s*<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>\s*<\/li>/g)];
  if (!rows.length) throw new Error('陕西西安市区油价：官网价格处列表为空');
  const entries = [];
  let previousDate = '';
  for (const row of rows) {
    const publishedDate = validDate(row[3], '列表发布日期');
    if (previousDate && publishedDate > previousDate) {
      throw new Error('陕西西安市区油价：官网列表日期顺序异常');
    }
    previousDate = publishedDate;
    const title = row[2].trim();
    if (title !== ANNOUNCEMENT_TITLE && !/^我省汽、柴油价格(?:按机制)?(?:上调|下调|调整)$/.test(title)) continue;
    const url = officialUrl(row[1], LIST_URL, ARTICLE_PATH, '公告');
    const path = ARTICLE_PATH.exec(new URL(url).pathname);
    if (path[1] !== publishedDate.slice(0, 7).replace('-', '') ||
        path[2] !== publishedDate.replaceAll('-', '')) {
      throw new Error(`陕西西安市区油价：公告地址日期与列表不符：${url}`);
    }
    entries.push({ title, publishedDate, effectiveDate: nextDate(publishedDate), url });
  }
  if (!entries.length) throw new Error('陕西西安市区油价：列表中没有调价公告');
  const effective = entries.filter(entry => entry.effectiveDate <= today);
  if (!effective.length) throw new Error('陕西西安市区油价：没有已生效的调价公告');
  const latestDate = effective[0].publishedDate;
  return effective.find(entry => entry.publishedDate === latestDate &&
    entry.title === ANNOUNCEMENT_TITLE) || effective[0];
}

function inspectArticle(html, entry) {
  const title = /<div class="title">\s*([^<]+)\s*<\/div>/.exec(html)?.[1]?.trim();
  const publishedDate = /<span>发布时间：(\d{4}-\d{2}-\d{2})<\/span>/.exec(html)?.[1];
  const source = /<span>来源：([^<]+)<\/span>/.exec(html)?.[1];
  if (title !== entry.title || publishedDate !== entry.publishedDate || source !== '价格处') {
    throw new Error(`陕西西安市区油价：公告标题、日期或发布单位不符：${entry.url}`);
  }
  const [year, month, day] = entry.publishedDate.split('-');
  const validTime = new RegExp(`自${year}年${Number(month)}月${Number(day)}日24时起`);
  if (!validTime.test(html.replace(/\s|&nbsp;/g, ''))) {
    throw new Error(`陕西西安市区油价：正文没有对应的 24 时生效时间：${entry.url}`);
  }
  if (entry.title !== ANNOUNCEMENT_TITLE) {
    // 有些调价日期只有新闻稿（列出 92 和 0 号），没有完整的 95 号价格表。
    return { ...entry, requiresManualLiterReview: true, missingOfficialPriceTable: true };
  }
  const images = [...new Set([...html.matchAll(/<img\b[^>]*src="([^"]+W020\d{18}(?:_ORIGIN)?\.(?:png|jpg))"/gi)]
    .map(match => match[1]))];
  if (images.length !== 1) throw new Error(`陕西西安市区油价：官方价格表图片缺失或重复：${entry.url}`);
  const imagePath = new RegExp(`^/zjww/jgcs/csxx/jgc/${year}${month}/W020${year.slice(2)}${month}${day}\\d{12}(?:_ORIGIN)?\\.(?:png|jpg)$`, 'i');
  return { ...entry, imageUrl: officialUrl(images[0], entry.url, imagePath, '价格表图片'),
    requiresManualLiterReview: true };
}

function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = {
  id: 'shaanxi-xian',
  name: '陕西·西安市区',
  sourceName: '陕西省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, getBuffer, today } = {}) {
    if (typeof getText !== 'function' || typeof getBuffer !== 'function') {
      throw new TypeError('陕西西安市区油价：需要官网文本和图片读取函数');
    }
    const day = validDate(today instanceof Date ? today.toISOString().slice(0, 10) :
      today ?? currentChinaDate(), '今天');
    const entry = latestEntry(await getText(LIST_URL), day);
    const result = inspectArticle(await getText(entry.url), entry);
    if (result.imageUrl) {
      const image = await getBuffer(result.imageUrl);
      const bytes = image?.buffer;
      const png = bytes?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
      const jpeg = bytes?.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
      if (!Buffer.isBuffer(bytes) || bytes.length < 2048 || (!png && !jpeg)) {
        throw new Error(`陕西西安市区油价：官方价格表图片内容异常：${result.imageUrl}`);
      }
    }
    return result;
  },
};
