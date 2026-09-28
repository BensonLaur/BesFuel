'use strict';

const HOSTNAME = 'fzggw.zj.gov.cn';
const COLUMN = '1229629046';
const API_URL = `https://${HOSTNAME}/api-gateway/jpaas-publish-server/front/page/build/unit`;
const SEARCH = { xxgkId: 'gggs', xxgkType: '', className: '重要公告' };
const QUERY = {
  parseType: 'bulidstatic', webId: '3185', tplSetId: 'o0YcVHHq5vWtr3uiCp4SY',
  pageType: 'column', tagId: '组配分类list', editType: 'null', pageId: COLUMN,
  paramJson: JSON.stringify({ pageNo: 1, pageSize: 100, search: JSON.stringify(SEARCH) }),
};
const LIST_URL = `${API_URL}?${new URLSearchParams(QUERY)}`;
const TITLE = /^浙江省成品油价格(?:按机制)?(?:调整|上调|下调|不作调整)$/;
const MAX_LIST_AGE_DAYS = 60;

function compact(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp|#160|#x[aA]0);/gi, ' ')
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
  const modern = new RegExp(`^/col/col${COLUMN}/art/${year}/art_[a-f0-9]{32}\\.html$`);
  const older = new RegExp(`^/art/${year}/\\d{1,2}/\\d{1,2}/art_${COLUMN}_\\d+\\.html$`);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username ||
      url.password || url.search || url.hash ||
      !(modern.test(url.pathname) || older.test(url.pathname))) {
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
  if (response.success !== true || typeof html !== 'string' ||
      !html.includes('<label class="label-className">重要公告</label>')) {
    throw new Error('浙江油价公告：官网重要公告列表结构异常');
  }
  const items = [...html.matchAll(/<li class="cf border-line">\s*<a\b[^>]*href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<span class="fr">(\d{4}-\d{2}-\d{2})<\/span>/g)];
  if (!items.length) throw new Error('浙江油价公告：官网重要公告列表为空');
  let previousDate = '';
  const oil = [];
  for (const item of items) {
    const listedDate = validDate(item[3], '列表日期');
    if (previousDate && listedDate > previousDate) throw new Error('浙江油价公告：列表日期顺序异常');
    previousDate = listedDate;
    const title = compact(item[2]);
    if (!title.startsWith('浙江省成品油价格')) continue;
    if (!TITLE.test(title)) throw new Error(`浙江油价公告：未知的油价公告标题：${title}`);
    oil.push({ title, publishedDate: listedDate, effectiveDate: nextDate(listedDate),
      url: officialUrl(item[1], listedDate) });
  }
  const latest = oil.find(entry => entry.effectiveDate <= today);
  if (!latest) throw new Error('浙江油价公告：列表中没有已生效的油价公告');
  // The public list stopped carrying oil notices after March 2026. Reject stale
  // discovery so a later update cannot present an old table as today's price.
  const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latest.publishedDate}T00:00:00Z`)) / 86400000;
  if (ageDays > MAX_LIST_AGE_DAYS) {
    throw new Error(`浙江油价公告：官网列表最新油价公告仅到 ${latest.publishedDate}，需查找新版官方来源`);
  }
  return latest;
}

function inspectArticle(html, entry) {
  const title = /<meta name="ArticleTitle" content="([^"]+)"/.exec(html)?.[1];
  const pubDate = /<meta name="PubDate" content="(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}"/.exec(html)?.[1];
  const column = /<meta name="ColumnName" content="([^"]+)"/.exec(html)?.[1];
  if (title !== entry.title || pubDate !== entry.publishedDate || column !== '重要公告' ||
      !html.includes(`发布日期：${entry.publishedDate}`)) {
    throw new Error(`浙江油价公告：正文标题、栏目或日期与列表不符：${entry.url}`);
  }
  const [year, month, day] = entry.publishedDate.split('-');
  const effectiveText = new RegExp(`(?:${year}年)?${Number(month)}月${Number(day)}日24时起`);
  if (!effectiveText.test(compact(html))) {
    throw new Error(`浙江油价公告：正文没有对应的 24 时生效日期：${entry.url}`);
  }
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
    for (const [grade, pattern] of grades) {
      const matches = priceRows.slice(2).filter(row => pattern.test(row[1]));
      if (matches.length !== 1 || matches[0].length !== 5 ||
          !/^\d{1,2}\.\d{2}$/.test(matches[0][3])) {
        throw new Error(`浙江油价公告：${grade} 元/升价格缺失或异常：${entry.url}`);
      }
    }
  }
  return { ...entry, requiresManualLiterReview: true };
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
