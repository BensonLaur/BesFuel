'use strict';

const HOSTNAME = 'sndrc.shaanxi.gov.cn';
const LIST_URL = `https://${HOSTNAME}/sy/xwxx/gggg/`;
const TITLE = '陕西省成品油价格调整通告';

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`陕西陕南价区：${label}无效：${value}`);
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
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.port || url.username ||
      url.password || url.search || url.hash || !pathname.test(url.pathname)) {
    throw new Error(`陕西陕南价区：${label}不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function latestNotice(html, today) {
  const entries = [...html.matchAll(/<li>\s*<a href="([^"]+)"[^>]*>\s*([^<]+)\s*<\/a>\s*<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>\s*<\/li>/g)]
    .filter(match => match[2].trim() === TITLE);
  if (!entries.length) throw new Error('陕西陕南价区：官网公示公告列表没有成品油价格通告');
  let previousDate = '';
  const notices = entries.map(match => {
    const publishedDate = validDate(match[3], '列表发布日期');
    if (previousDate && publishedDate >= previousDate) {
      throw new Error('陕西陕南价区：官网成品油通告日期顺序异常');
    }
    previousDate = publishedDate;
    const stamp = publishedDate.replaceAll('-', '');
    const path = new RegExp(`^/sy/xwxx/gggg/${stamp.slice(0, 6)}/t${stamp}_\\d+\\.html$`);
    return { publishedDate, effectiveDate: nextDate(publishedDate),
      url: officialUrl(match[1], LIST_URL, path, '价格通告') };
  });
  const notice = notices.find(entry => entry.effectiveDate <= today);
  if (!notice) throw new Error('陕西陕南价区：列表中没有已生效的价格通告');
  return notice;
}

function inspectArticle(html, notice) {
  const title = /<div class="title">\s*([^<]+)\s*<\/div>/.exec(html)?.[1].trim();
  const source = /<span>来源：([^<]+)<\/span>/.exec(html)?.[1].trim();
  const publishedDate = /<span>发布时间：(\d{4}-\d{2}-\d{2})<\/span>/.exec(html)?.[1];
  const body = html.slice(html.indexOf('tyxlContent'));
  if (title !== TITLE || source !== '价格处' || publishedDate !== notice.publishedDate ||
      !body.includes('汽、柴油最高零售价格公布如下')) {
    throw new Error(`陕西陕南价区：价格通告标题、来源或日期异常：${notice.url}`);
  }
  const [year, month, day] = notice.publishedDate.split('-');
  if (!body.replace(/\s|&nbsp;/g, '').includes(`自${year}年${Number(month)}月${Number(day)}日24时起执行`)) {
    throw new Error(`陕西陕南价区：价格通告没有对应的 24 时执行时间：${notice.url}`);
  }
  const images = [...body.matchAll(/<img\b[^>]*src="([^\"]+)"/g)]
    .map(match => match[1]).filter(src => /(?:^|\/)W020\d+(?:_ORIGIN)?\.png$/.test(src));
  if (images.length !== 1) throw new Error(`陕西陕南价区：官方价格表图片缺失或重复：${notice.url}`);
  const stamp = notice.publishedDate.replaceAll('-', '');
  const imagePath = new RegExp(`^/sy/xwxx/gggg/${stamp.slice(0, 6)}/W020${stamp.slice(2)}\\d+(?:_ORIGIN)?\\.png$`);
  const imageUrl = officialUrl(images[0], notice.url, imagePath, '价格表图片');
  // 官网以图片公布元/升表格；图片变化时必须先人工核对行列，不能自动猜价。
  return { ...notice, imageUrl, requiresManualPriceReview: true };
}

module.exports = {
  id: 'shaanxi-south',
  name: '陕西·陕南（汉中、安康、商洛）',
  sourceName: '陕西省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, getBuffer, today } = {}) {
    if (typeof getText !== 'function' || typeof getBuffer !== 'function') {
      throw new TypeError('陕西陕南价区：需要官网文本及图片读取函数');
    }
    const day = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today ?? currentChinaDate(), '今天');
    const notice = latestNotice(await getText(LIST_URL), day);
    const result = inspectArticle(await getText(notice.url), notice);
    const image = await getBuffer(result.imageUrl);
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!Buffer.isBuffer(image?.buffer) || image.buffer.length < 5000 ||
        !image.buffer.subarray(0, 8).equals(pngSignature)) {
      throw new Error(`陕西陕南价区：官方价格表 PNG 内容异常：${result.imageUrl}`);
    }
    return result;
  },
};
