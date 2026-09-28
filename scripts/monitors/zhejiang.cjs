'use strict';

const HOSTNAME = 'fzggw.zj.gov.cn';
const API_URL = `https://${HOSTNAME}/api-gateway/jpaas-publish-server/front/page/build/unit`;
// 新版成品油价格栏目与旧“重要公告”栏目使用不同的列表标签和 pageId。
const QUERY = {
  parseType: 'bulidstatic', webId: '3185', tplSetId: 'o0YcVHHq5vWtr3uiCp4SY',
  pageType: 'column', tagId: '信息列表', editType: 'null', pageId: 'WjmRjo8myrcFv0ZgeuKKh',
  paramJson: JSON.stringify({ pageNo: 1, pageSize: 100 }),
};
const LIST_URL = `${API_URL}?${new URLSearchParams(QUERY)}`;
const TITLE = /^浙江省成品油价格(?:按机制)?(?:调整|上调|下调|不作调整)$/;
const MAX_LIST_AGE_DAYS = 60;

function compact(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:nbsp|ensp|emsp|#160|#x[aA]0);/gi, ' ')
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`浙江油价公告：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function officialUrl(reference, listedDate) {
  const url = new URL(reference, API_URL);
  const year = listedDate.slice(0, 4);
  // 9 月 11 日的价表列在成品油栏目，但原文位于“通知公告”栏目。
  const path = new RegExp(`^/col/col(?:1632199/cpyjg|1599544|1229629046)/art/${year}/art_[a-f0-9]{32}\\.html$`);
  const legacy = new RegExp(`^/art/${year}/\\d{1,2}/\\d{1,2}/art_1229629046_\\d+\\.html$`);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.port ||
      url.username || url.password || url.search || url.hash ||
      !(path.test(url.pathname) || legacy.test(url.pathname))) {
    throw new Error(`浙江油价公告：非预期官方公告地址：${url.href}`);
  }
  return url.href;
}

function latestEntry(payload, today) {
  let response;
  try { response = JSON.parse(payload); } catch (_) {
    throw new Error('浙江油价公告：官网列表接口不是 JSON');
  }
  const html = response?.data?.html;
  if (response.success !== true || typeof html !== 'string' || !html.includes('<div id="信息列表">')) {
    throw new Error('浙江油价公告：官网成品油价格列表结构异常');
  }
  const items = [...html.matchAll(/<li class="clearfix">\s*<a\b[^>]*title="([^"]+)"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span class="bt-right">(\d{4}-\d{2}-\d{2})<\/span>/g)];
  if (!items.length) throw new Error('浙江油价公告：官网成品油价格列表为空');
  let previousDate = '';
  const oil = [];
  for (const item of items) {
    const listedDate = validDate(item[3], '列表日期');
    if (previousDate && listedDate > previousDate) throw new Error('浙江油价公告：列表日期顺序异常');
    previousDate = listedDate;
    const title = compact(item[1]);
    if (!title.startsWith('浙江省成品油价格')) continue;
    if (!TITLE.test(title)) throw new Error(`浙江油价公告：未知的油价公告标题：${title}`);
    oil.push({ title, publishedDate: listedDate, effectiveDate: nextDate(listedDate),
      url: officialUrl(item[2], listedDate) });
  }
  const latest = oil.find(entry => entry.effectiveDate <= today);
  if (!latest) throw new Error('浙江油价公告：列表中没有已生效的油价公告');
  const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest.publishedDate}T00:00:00Z`)) / 86400000;
  if (ageDays > MAX_LIST_AGE_DAYS) {
    throw new Error(`浙江油价公告：官网列表最新油价公告仅到 ${latest.publishedDate}，需复核新版官方来源`);
  }
  return latest;
}

function inspectArticle(html, entry) {
  const title = /<meta name="ArticleTitle" content="([^"]+)"/.exec(html)?.[1];
  const pubDate = /<meta name="PubDate" content="(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}"/.exec(html)?.[1];
  const column = /<meta name="ColumnName" content="([^"]+)"/.exec(html)?.[1];
  const source = /<meta name="ContentSource" content="([^"]+)"/.exec(html)?.[1];
  const expectedColumn = entry.url.includes('/col/col1599544/') ? '通知公告' :
    entry.url.includes('/col/col1229629046/') ? '重要公告' : '成品油价格';
  if (title !== entry.title || pubDate !== entry.publishedDate ||
      column !== expectedColumn || source !== '价格处' ||
      !html.includes(`发布日期：${entry.publishedDate}`)) {
    throw new Error(`浙江油价公告：正文标题、栏目、来源或日期与列表不符：${entry.url}`);
  }
  const [year, month, day] = entry.publishedDate.split('-');
  const effectiveText = new RegExp(`(?:${year}年)?${Number(month)}月${Number(day)}日24时起`);
  if (!effectiveText.test(compact(html))) {
    throw new Error(`浙江油价公告：正文没有对应的 24 时生效日期：${entry.url}`);
  }
  let prices;
  if (!entry.title.endsWith('不作调整')) {
    const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
    const rows = tables.map(table => [...table[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(row => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(cell => compact(cell[1]))));
    const priceRows = rows.find(table => table[0]?.join('|') === '品种|型号|零售价|批发价' &&
      table[1]?.join('|') === '元/吨|元/升|元/吨');
    if (!priceRows) throw new Error(`浙江油价公告：未找到含元/升列的官方价格表：${entry.url}`);
    const grades = [['92', /^92号[（(](?:ⅥB|VIB)[）)]$/],
      ['95', /^95号[（(](?:ⅥB|VIB)[）)]$/], ['diesel', /^0号[（(]Ⅵ[）)]$/]];
    prices = {};
    for (const [grade, pattern] of grades) {
      const matches = priceRows.slice(2).filter(row => pattern.test(row[1]));
      if (matches.length !== 1 || matches[0].length !== 5 ||
          !/^\d{1,2}\.\d{2}$/.test(matches[0][3])) {
        throw new Error(`浙江油价公告：${grade} 元/升价格缺失或异常：${entry.url}`);
      }
      prices[grade] = Number(matches[0][3]);
    }
  }
  return { ...entry, ...(prices ? { prices } : {}), requiresManualLiterReview: true };
}

function currentChinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = {
  id: 'zhejiang',
  name: '浙江',
  sourceName: '浙江省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today } = {}) {
    if (typeof getText !== 'function') throw new TypeError('浙江油价公告：getText 必须为函数');
    const day = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today ?? currentChinaDate(), '今天');
    const entry = latestEntry(await getText(LIST_URL), day);
    return inspectArticle(await getText(entry.url), entry);
  },
};
