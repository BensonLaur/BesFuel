'use strict';

const HOSTNAME = 'yndrc.yn.gov.cn';
const LIST_URL = `https://${HOSTNAME}/html/fagaishuju/jiagegongbu/meidianyouqi/`;
const TITLE = '云南省成品油价格按机制调整';

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`云南第三价格组：${label}无效：${value}`);
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
    throw new Error(`云南第三价格组：${label}不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function latestEntry(html, today) {
  if (!/<meta name="ColumnName" content="成品油价格"/.test(html) ||
      !html.includes('<div class="list-content">')) {
    throw new Error('云南第三价格组：官网成品油价格栏目结构异常');
  }
  const content = html.match(/<div class="list-content">\s*<ul>([\s\S]*?)<div class="pagenav">/);
  if (!content) throw new Error('云南第三价格组：官网成品油价格列表缺失');
  const items = [...content[1].matchAll(/<li>\s*<a href="([^"]+)">([^<]+)<\/a>\s*<span>(\d{4}-\d{2}-\d{2})<\/span>\s*<\/li>/g)];
  if (!items.length) throw new Error('云南第三价格组：官网成品油价格列表为空');
  const entries = [];
  let previousDate = '';
  for (const item of items) {
    const publishedDate = validDate(item[3], '列表发布日期');
    if (previousDate && publishedDate >= previousDate) {
      throw new Error('云南第三价格组：官网公告列表日期顺序异常');
    }
    previousDate = publishedDate;
    if (item[2].trim() !== TITLE) {
      throw new Error(`云南第三价格组：未知的成品油公告标题：${item[2].trim()}`);
    }
    const [year, month, day] = publishedDate.split('-');
    const path = new RegExp(`^/html/${year}/(?:meidianyouqi|jiageyushoufei)_${month}${day}/\\d+\\.html$`);
    entries.push({ publishedDate, effectiveDate: nextDate(publishedDate),
      url: officialUrl(item[1], LIST_URL, path, '公告') });
  }
  const latest = entries.find(entry => entry.effectiveDate <= today);
  if (!latest) throw new Error('云南第三价格组：没有已生效的官网公告');
  return latest;
}

function inspectArticle(html, entry) {
  const title = /<meta name="ArticleTitle" content="([^"]+)"/.exec(html)?.[1];
  const pubDate = /<meta name="PubDate" content="(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}"/.exec(html)?.[1];
  const column = /<meta name="ColumnName" content="([^"]+)"/.exec(html)?.[1];
  const source = /<meta name="ContentSource" content="([^"]+)"/.exec(html)?.[1];
  const heading = /<div class="show-title">([^<]+)<\/div>/.exec(html)?.[1];
  if (title !== TITLE || heading !== TITLE || pubDate !== entry.publishedDate ||
      !['成品油价格', '价格与收费'].includes(column) || source !== '价格收费管理处') {
    throw new Error(`云南第三价格组：公告正文标题、日期或发布单位与列表不符：${entry.url}`);
  }
  const [year, month, day] = entry.publishedDate.split('-');
  const validTime = new RegExp(`(?:${year}年)?${Number(month)}月${Number(day)}日24时起`);
  if (!validTime.test(html.replace(/\s|&nbsp;|&thinsp;/g, ''))) {
    throw new Error(`云南第三价格组：正文没有对应的 24 时生效时间：${entry.url}`);
  }
  const matches = [...html.matchAll(/<a\b[^>]*href="([^"]+\.pdf)"[^>]*>([^<]*)<\/a>/g)]
    .filter(match => match[2].trim() === '云南省各地区汽、柴油最高零售价格表');
  if (matches.length !== 1) throw new Error(`云南第三价格组：官方价格表 PDF 缺失或重复：${entry.url}`);
  const pdfPath = new RegExp(`^/uploadfile/s2/${year}/${month}${day}/${year}${month}${day}\\d{9}\\.pdf$`);
  const pdfUrl = officialUrl(matches[0][1], entry.url, pdfPath, '价格表 PDF');
  // PDF 中的昭通、红河、文山、大理四地元/升价格需要逐期人工复核。
  return { ...entry, pdfUrl, requiresManualPriceReview: true };
}

function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = {
  id: 'yunnan-zone3',
  name: '云南·昭通、红河、文山、大理',
  sourceName: '云南省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, getBuffer, today } = {}) {
    if (typeof getText !== 'function' || typeof getBuffer !== 'function') {
      throw new TypeError('云南第三价格组：需要官网文本及 PDF 读取函数');
    }
    const day = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today ?? currentChinaDate(), '今天');
    const entry = latestEntry(await getText(LIST_URL), day);
    const result = inspectArticle(await getText(entry.url), entry);
    const pdf = await getBuffer(result.pdfUrl);
    if (!Buffer.isBuffer(pdf?.buffer) || pdf.buffer.length < 1024 ||
        pdf.buffer.toString('ascii', 0, 5) !== '%PDF-' ||
        pdf.buffer.lastIndexOf('%%EOF') < pdf.buffer.length - 1024) {
      throw new Error(`云南第三价格组：官方价格表 PDF 内容异常：${result.pdfUrl}`);
    }
    return result;
  },
};
