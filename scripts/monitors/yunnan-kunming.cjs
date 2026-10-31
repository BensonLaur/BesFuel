"use strict";

const HOSTNAME = 'yndrc.yn.gov.cn';
const LIST_URL = `https://${HOSTNAME}/fgsj/jggb/cpyjg/`;
const TITLE = '云南省成品油价格按机制调整';
const LEGACY = /^\/html\/(\d{4})\/(?:meidianyouqi|jiageyushoufei)_(\d{4})\/\d+\.html$/;
const CURRENT = /^\/(?:fgsj\/jggb\/cpyjg|zwgk\/fdzdgknr\/jgysf)\/(\d{6})\/t(\d{8})_\d+\.html$/;
const compact = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, '')
  .replace(/&(?:nbsp|thinsp);|\s/g, '');

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`云南成品油公告：${label}无效：${value}`);
  }
  return value;
}
function nextDate(value) { return new Date(Date.parse(value) + 86400000).toISOString().slice(0, 10); }
function officialUrl(reference, base) {
  const url = new URL(reference, base);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error(`云南成品油公告：不是预期的官网地址：${url.href}`);
  }
  return url;
}
function articleUrl(reference, date) {
  const url = officialUrl(reference, LIST_URL), legacy = url.pathname.match(LEGACY), current = url.pathname.match(CURRENT);
  const stamp = date.replace(/-/g, '');
  if (legacy ? legacy[1] + legacy[2] !== stamp : !current || current[1] !== stamp.slice(0, 6) || current[2] !== stamp) {
    throw new Error(`云南成品油公告：公告路径与列表日期不符：${url.href}`);
  }
  return url.href;
}
function latestEntry(html, today) {
  if (!/<meta name="ColumnName" content="成品油价格"/.test(html)) throw new Error('云南成品油公告：官网成品油价格栏目结构异常');
  const block = /<div class="list-content">\s*<ul>([\s\S]*?)<\/ul>/i.exec(html)?.[1];
  if (!block) throw new Error('云南成品油公告：官网成品油价格列表缺失');
  const entries = [], anchors = [...block.matchAll(/<a\b[^>]*>[^<]*成品油价格[^<]*<\/a>/gi)];
  for (const item of block.matchAll(/<li\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>\s*<span>(\d{4}-\d{2}-\d{2})<\/span>\s*<\/li>/gi)) {
    const title = item[2].trim();
    if (!title.includes('成品油价格')) continue;
    if (title !== TITLE) throw new Error(`云南成品油公告：未知的成品油公告标题：${title}`);
    const date = validDate(item[3], '列表日期');
    if (entries.length && date > entries.at(-1).publishedDate) throw new Error('云南成品油公告：官网公告列表日期顺序异常');
    entries.push({ title, publishedDate: date, effectiveDate: nextDate(date), url: articleUrl(item[1], date) });
  }
  if (!entries.length || entries.length !== anchors.length) throw new Error('云南成品油公告：官网油价列表缺失或结构已变化');
  const latest = entries.find(entry => entry.effectiveDate <= today);
  if (!latest) throw new Error('云南成品油公告：没有已生效的官网公告');
  // The migrated column contains older same-day mirrors. A duplicate of the
  // selected latest day still needs review; never choose one arbitrarily.
  if (entries.filter(entry => entry.publishedDate === latest.publishedDate).length !== 1) throw new Error('云南成品油公告：最新公告日期不唯一');
  if ((Date.parse(today) - Date.parse(latest.publishedDate)) / 86400000 > 60) throw new Error('云南成品油公告：官网列表过旧，需复核官方来源');
  return latest;
}
function inspectArticle(html, entry) {
  const meta = name => new RegExp(`<meta name="${name}" content="([^"]+)"`, 'i').exec(html)?.[1];
  const source = meta('ContentSource'), migrated = Boolean(new URL(entry.url).pathname.match(CURRENT));
  const published = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}$/.exec(meta('PubDate') || '')?.[1];
  const text = compact(html);
  const department = ['价格收费管理处', '价格监测与成本调查处'];
  if (meta('ArticleTitle') !== TITLE || published !== entry.publishedDate ||
      !['成品油价格', '价格与收费'].includes(meta('ColumnName')) ||
      (migrated ? source !== '云南省发展和改革委员会' || !department.some(value => text.includes(`来源：${value}`)) : !department.includes(source)) ||
      /<div class="show-title">([^<]+)<\/div>/.exec(html)?.[1] !== TITLE) {
    throw new Error(`云南成品油公告：公告正文标题、日期或发布单位与列表不符：${entry.url}`);
  }
  const [year, month, day] = entry.publishedDate.split('-');
  if (!new RegExp(`(?:${year}年)?${Number(month)}月${Number(day)}日24时起`).test(text)) {
    throw new Error(`云南成品油公告：正文没有对应的 24 时生效时间：${entry.url}`);
  }
  if (migrated && (!text.includes('云南省各地区的汽、柴油最高零售价格见附表') ||
      !text.includes(`云南省发展和改革委员会${year}年${Number(month)}月${Number(day)}日`))) {
    throw new Error(`云南成品油公告：省内价格表说明或落款日期不符：${entry.url}`);
  }
  const attachments = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .filter(match => compact(match[2]) === '云南省各地区汽、柴油最高零售价格表');
  if (attachments.length !== 1) throw new Error('云南成品油公告：官方价格表 PDF 缺失或重复');
  const href = /\bhref="([^"]+)"/i.exec(attachments[0][1])?.[1];
  if (!href) throw new Error('云南成品油公告：价格表 PDF 缺少地址');
  const pdf = officialUrl(href, entry.url), stamp = entry.publishedDate.replace(/-/g, '');
  if (migrated) {
    // Migration may re-upload old PDFs under a newer file stamp. Bind the PDF
    // to this announcement's directory, then verify its own effective date.
    const prefix = new URL(entry.url).pathname.replace(/[^/]+$/, '');
    if (!pdf.pathname.startsWith(prefix) || !/^P0\d{20}\.pdf$/.test(pdf.pathname.slice(prefix.length))) {
      throw new Error(`云南成品油公告：价格表 PDF 不是该公告的官网附件：${pdf.href}`);
    }
  } else if (!new RegExp(`^/uploadfile/s2/${year}/${month}${day}/${stamp}\\d{9}\\.pdf$`).test(pdf.pathname)) {
    throw new Error(`云南成品油公告：PDF 日期与公告不符：${pdf.href}`);
  }
  return { ...entry, pdfUrl: pdf.href, requiresManualLiterReview: true };
}
function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
module.exports = {
  id: 'yunnan-kunming', name: '云南·昆明', sourceName: '云南省发展和改革委员会', allowedHostnames: [HOSTNAME],
  async collect({ getText, getBuffer, today } = {}) {
    if (typeof getText !== 'function' || typeof getBuffer !== 'function') throw new TypeError('云南成品油公告：需要官网文本及 PDF 读取函数');
    const day = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today ?? currentChinaDate(), '今天');
    const entry = latestEntry(await getText(LIST_URL), day);
    const result = inspectArticle(await getText(entry.url), entry);
    const pdf = await getBuffer(result.pdfUrl);
    if (!Buffer.isBuffer(pdf?.buffer) || pdf.buffer.length < 1024 || pdf.buffer.toString('ascii', 0, 5) !== '%PDF-' ||
        pdf.buffer.lastIndexOf('%%EOF') < pdf.buffer.length - 1024) throw new Error(`云南成品油公告：官方价格表 PDF 内容异常：${result.pdfUrl}`);
    return result;
  }
};
