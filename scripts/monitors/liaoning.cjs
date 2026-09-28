'use strict';

const LIST_URL = 'https://fgw.ln.gov.cn/fgw/index/tzgg/index.shtml';
const HOSTNAME = 'fgw.ln.gov.cn';
const TITLE = /^辽宁省成品油价格调整公告（(\d{4})年(\d{1,2})月(\d{1,2})日24时起执行）$/;

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`辽宁油价公告：${label}无效：${value}`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`辽宁油价公告：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function officialPdf(reference, publishedDate) {
  const viewer = new URL(reference, LIST_URL);
  if (viewer.protocol !== 'https:' || viewer.hostname !== HOSTNAME ||
      viewer.username || viewer.password || viewer.hash ||
      viewer.pathname !== '/uiFramework/js/pdfjs/web/viewer.html') {
    throw new Error(`辽宁油价公告：PDF 阅读器不是预期的官网地址：${viewer.href}`);
  }
  const path = viewer.searchParams.get('file');
  const url = new URL(path || '', `https://${HOSTNAME}`);
  const fileDate = publishedDate.replace(/-/g, '');
  const expected = new RegExp(`^/fgw/articleFileDir/${publishedDate.slice(0, 7)}/${publishedDate.slice(8)}/[0-9a-f]{32}/${fileDate}\\d+\\.pdf$`);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME ||
      url.username || url.password || url.search || url.hash || !expected.test(url.pathname)) {
    throw new Error(`辽宁油价公告：PDF 不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function entries(html) {
  const found = [];
  const rows = [...html.matchAll(/<li>\s*<a\b([^>]+)>[^<]*<\/a>\s*<span class="datetime">(\d{4}-\d{2}-\d{2})<\/span>\s*<\/li>/gi)];
  for (const row of rows) {
    const attributes = row[1];
    const title = /\btitle="([^"]+)"/.exec(attributes)?.[1];
    if (!title?.startsWith('辽宁省成品油价格调整公告')) continue;
    const match = TITLE.exec(title);
    if (!match) throw new Error(`辽宁油价公告：未知的公告标题：${title}`);
    const publishedDate = validDate(row[2], '列表发布日期');
    const titleDate = validDate(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, '标题调价日期');
    if (titleDate !== publishedDate) throw new Error(`辽宁油价公告：标题与列表日期不一致：${title}`);
    const href = /\bhref="([^"]+)"/.exec(attributes)?.[1];
    if (!href) throw new Error(`辽宁油价公告：缺少 PDF 地址：${title}`);
    found.push({
      publishedDate,
      effectiveDate: nextDate(publishedDate),
      url: officialPdf(href.replace(/&amp;/g, '&'), publishedDate),
      requiresManualLiterReview: true,
    });
  }
  if (!found.length) throw new Error('辽宁油价公告：官网列表中未找到调价公告');
  for (let i = 1; i < found.length; i += 1) {
    if (found[i].publishedDate >= found[i - 1].publishedDate) {
      throw new Error('辽宁油价公告：列表日期顺序异常或公告重复');
    }
  }
  return found;
}

module.exports = {
  id: 'liaoning',
  name: '辽宁',
  sourceName: '辽宁省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today }) {
    if (typeof getText !== 'function') throw new TypeError('辽宁油价公告：getText 必须为函数');
    const currentDay = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today, '今天');
    const notices = entries(await getText(LIST_URL)).filter(entry => entry.effectiveDate <= currentDay);
    if (!notices.length) throw new Error('辽宁油价公告：未找到已生效的官网公告');
    return notices[0];
  },
};
