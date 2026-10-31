'use strict';

const HOSTNAME = 'fgw.qinghai.gov.cn';
const NOTICE_LIST_URL = `http://${HOSTNAME}/xwzx/tzgg/`;
const PRICE_LIST_URL = `http://${HOSTNAME}/sjfb/jgdt/`;
const TITLES = new Set([
  '我省调整省内成品油最高零售价格',
  '我省下调省内成品油最高零售价格',
]);

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`青海二价区：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function officialUrl(reference, baseUrl, pathname, label) {
  const url = new URL(reference, baseUrl);
  // 省发改委官网目前仅通过 HTTP 响应；地址与路径仍必须严格限制在本站。
  if (url.protocol !== 'http:' || url.hostname !== HOSTNAME || url.port || url.username ||
      url.password || url.search || url.hash || !pathname.test(url.pathname)) {
    throw new Error(`青海二价区：${label}不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function inspectUploadPath(url, pattern, label) {
  const [, directory, stamp] = new URL(url).pathname.match(pattern);
  validDate(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6)}`, `${label}文件日期`);
  if (directory !== stamp.slice(0, 6)) throw new Error(`青海二价区：${label}目录与文件日期不符：${url}`);
}

function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function entriesFromList(html, listUrl, section) {
  const matches = [...html.matchAll(/<li class="clearfix"><a href="([^"]+)"[^>]*>\s*([^<]+)\s*<\/a><span>\[\s*(\d{4}-\d{2}-\d{2})\]\s*<\/span>/g)]
    .filter(match => TITLES.has(match[2].trim()));
  if (!matches.length) throw new Error(`青海二价区：官网${section}列表没有成品油通告`);
  const entries = [];
  let previous = '';
  for (const match of matches) {
    const publishedDate = validDate(match[3], '列表发布日期');
    if (previous && publishedDate >= previous) throw new Error(`青海二价区：官网${section}通告日期顺序异常`);
    previous = publishedDate;
    // 价格动态栏目曾把 7 月 31 日公告重新挂到 8 月目录，列表日期以正文再核对。
    const path = new RegExp(`^/${section}/(\\d{6})/t(\\d{8})_\\d+\\.html$`);
    const url = officialUrl(match[1], listUrl, path, '价格通告');
    inspectUploadPath(url, path, '价格通告');
    entries.push({ publishedDate, effectiveDate: nextDate(publishedDate), title: match[2].trim(),
      url, section });
  }
  return entries;
}

function inspectArticle(html, notice) {
  const title = /<h1>\s*([^<]+)\s*<\/h1>/.exec(html)?.[1].trim();
  const source = /来源：(价格处(?:提供|供稿))/.exec(html)?.[1];
  const publication = /<span>发布时间：(\d{4})年(\d{2})月(\d{2})日 \d{2}:\d{2}<\/span>/.exec(html);
  const publishedDate = publication && `${publication[1]}-${publication[2]}-${publication[3]}`;
  const body = html.slice(html.indexOf('<div class="view TRS_UEDITOR'));
  if (title !== notice.title || !source || publishedDate !== notice.publishedDate ||
      !body.includes('省内各价区汽、柴油最高零售价格')) {
    throw new Error(`青海二价区：价格通告标题、来源或日期异常：${notice.url}`);
  }
  const [year, month, day] = notice.publishedDate.split('-');
  const plain = body.replace(/<[^>]*>|\s|&nbsp;/g, '');
  if (!new RegExp(`我省自${year}年0?${Number(month)}月0?${Number(day)}日24时起同步调整省内各价区汽、柴油最高零售价格`).test(plain)) {
    throw new Error(`青海二价区：通告没有对应的 24 时执行时间：${notice.url}`);
  }
  const images = [...body.matchAll(/<img\b[^>]*src="([^"]+)"/g)]
    .map(match => match[1]).filter(src => /(?:^|\/)W020\d+\.(?:JPG|jpg|png)$/.test(src));
  if (images.length !== 1) throw new Error(`青海二价区：官方价格表图片缺失或重复：${notice.url}`);
  // 公告和图片可能在发布后重新上传；绑定公告目录，业务日期仍从正文核验。
  const imagePath = new RegExp(`^/${notice.section}/(\\d{6})/W0(\\d{8})\\d+\\.(?:jpe?g|png)$`, 'i');
  const imageUrl = officialUrl(images[0], notice.url, imagePath, '价格表图片');
  inspectUploadPath(imageUrl, imagePath, '价格表图片');
  if (new URL(imageUrl).pathname.slice(0, new URL(imageUrl).pathname.lastIndexOf('/')) !==
      new URL(notice.url).pathname.slice(0, new URL(notice.url).pathname.lastIndexOf('/'))) {
    throw new Error(`青海二价区：价格表图片不在公告目录：${imageUrl}`);
  }
  // 元/升价格印在图片内，必须人工核对二价区行后才能更新站点数据。
  return { publishedDate: notice.publishedDate, effectiveDate: notice.effectiveDate,
    url: notice.url, imageUrl, requiresManualPriceReview: true };
}

module.exports = {
  id: 'qinghai-zone2',
  name: '青海·二价区',
  sourceName: '青海省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, getBuffer, today } = {}) {
    if (typeof getText !== 'function' || typeof getBuffer !== 'function') {
      throw new TypeError('青海二价区：需要官网文本及图片读取函数');
    }
    const day = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today ?? currentChinaDate(), '今天');
    const [noticeList, priceList] = await Promise.all([
      getText(NOTICE_LIST_URL), getText(PRICE_LIST_URL),
    ]);
    const entries = [
      ...entriesFromList(noticeList, NOTICE_LIST_URL, 'xwzx/tzgg'),
      ...entriesFromList(priceList, PRICE_LIST_URL, 'sjfb/jgdt'),
    ].sort((left, right) => right.publishedDate.localeCompare(left.publishedDate) ||
      (left.section === 'xwzx/tzgg' ? -1 : 1));
    const notice = entries.find(entry => entry.effectiveDate <= day);
    if (!notice) throw new Error('青海二价区：官网列表中没有已生效的价格通告');
    const result = inspectArticle(await getText(notice.url), notice);
    const image = await getBuffer(result.imageUrl);
    const bytes = image?.buffer;
    const isPng = Buffer.isBuffer(bytes) && bytes.subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = Buffer.isBuffer(bytes) && bytes.subarray(0, 3)
      .equals(Buffer.from([255, 216, 255]));
    if (!Buffer.isBuffer(bytes) || bytes.length < 5000 || !(isPng || isJpeg)) {
      throw new Error(`青海二价区：官方价格表图片内容异常：${result.imageUrl}`);
    }
    return result;
  },
};
