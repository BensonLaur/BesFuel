'use strict';

const BASE_URL = 'https://fgw.shanxi.gov.cn/tzgg/';
const HOSTNAME = 'fgw.shanxi.gov.cn';
const TITLE = '关于调整我省成品油零售价格的公告';
const LOOKBACK_DAYS = 90;
const MAX_PAGES = 100;

function plainText(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|#160|#xA0);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, '')
    .trim();
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`山西油价：${label}无效：${value}`);
  }
  return value;
}

function nextDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function officialUrl(reference, baseUrl) {
  const url = new URL(reference, baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username ||
      url.password || url.search || url.hash ||
      !/^\/tzgg\/\d{6}\/t\d{8}_\d+\.shtml$/.test(url.pathname)) {
    throw new Error(`山西油价：公告不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function parseList(html, pageUrl, page) {
  const pagination = html.match(/createPageHTML\((\d+),(\d+),"index","shtml"\)/);
  const count = Number(pagination?.[1]);
  if (!pagination || count < 1 || count > MAX_PAGES || Number(pagination[2]) !== page) {
    throw new Error(`山西油价：列表分页信息异常：${pageUrl}`);
  }
  const list = html.match(/<ul class="submenu-dropbox_subtabs_content[^\"]*">([\s\S]*?)<\/ul>/);
  if (!list) throw new Error(`山西油价：缺少公告列表：${pageUrl}`);
  const entries = [];
  for (const item of list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
    const anchor = item[1].match(/<a\b[^>]*href="([^"]+)"[^>]*title="([^"]+)"[^>]*>/);
    const date = item[1].match(/<em>(\d{4}-\d{2}-\d{2})<\/em>/);
    if (!anchor || !date) throw new Error(`山西油价：列表条目结构异常：${pageUrl}`);
    const title = plainText(anchor[2]);
    const publishedDate = validDate(date[1], '列表发布日期');
    if (title.includes('成品油') && title !== TITLE) {
      throw new Error(`山西油价：未知的成品油公告标题：${title}`);
    }
    entries.push({ title, publishedDate, reference: anchor[1] });
  }
  if (!entries.length) throw new Error(`山西油价：公告列表为空：${pageUrl}`);
  return { pageCount: count, entries };
}

function parsePrices(body, url) {
  if (!plainText(body).includes('山西省成品油最高零售价格表')) {
    throw new Error(`山西油价：缺少省级最高零售价格表：${url}`);
  }
  const tables = [...body.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tables.length !== 1) throw new Error(`山西油价：价格表数量异常：${url}`);
  const rows = [...tables[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => plainText(cell[1])));
  if (rows.length < 5 || rows[0].join('|') !== '品种|品号|最高零售价格（元/吨）|最高零售价格（元/升）') {
    throw new Error(`山西油价：价格表列标题异常：${url}`);
  }
  const prices = {};
  let group = '';
  for (const row of rows.slice(1)) {
    if (!row.length) continue;
    if (row.length === 4) group = row[0];
    else if (row.length !== 3) throw new Error(`山西油价：价格表行结构异常：${url}`);
    const [grade, perTon, perLiter] = row.slice(-3);
    let key;
    if (grade === '92号' || grade === '95号') {
      if (!/^汽油（/.test(group)) throw new Error(`山西油价：${grade}品种异常：${url}`);
      key = grade.slice(0, 2);
    } else if (grade === '0号') {
      if (!/^柴油（/.test(group)) throw new Error(`山西油价：0号柴油品种异常：${url}`);
      key = 'diesel';
    }
    if (!key) continue;
    if (Object.hasOwn(prices, key) || !/^\d+$/.test(perTon) ||
        !/^\d+\.\d{2}$/.test(perLiter) || Number(perTon) <= 0 || Number(perLiter) <= 0) {
      throw new Error(`山西油价：${grade}元/升价格缺失、重复或异常：${url}`);
    }
    prices[key] = Number(perLiter);
  }
  if (Object.keys(prices).length !== 3) throw new Error(`山西油价：92号、95号或0号柴油价格缺失：${url}`);
  return prices;
}

function parseArticle(html, entry) {
  const title = html.match(/<h3>\s*([^<]+)\s*<\/h3>/);
  if (!title || plainText(title[1]) !== entry.title) {
    throw new Error(`山西油价：公告标题与列表不符：${entry.url}`);
  }
  const meta = html.match(/<meta name="PubDate" content="(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}">/);
  const display = html.match(/<span><i>时间：<\/i>(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}<\/span>/);
  if (!meta || !display || validDate(meta[1], '元数据发布日期') !== entry.publishedDate ||
      validDate(display[1], '正文发布日期') !== entry.publishedDate) {
    throw new Error(`山西油价：发布日期与列表不符：${entry.url}`);
  }
  const start = html.indexOf('<!-- Main text -->');
  const end = html.indexOf('<!-- /Main text -->', start);
  if (start < 0 || end < 0) throw new Error(`山西油价：缺少公告正文：${entry.url}`);
  const body = html.slice(start, end);
  const text = plainText(body);
  const times = [...text.matchAll(/自(\d{4})年(\d{1,2})月(\d{1,2})日24时起，山西省内汽、柴油价格/g)];
  if (times.length !== 1) throw new Error(`山西油价：生效时间缺失或不唯一：${entry.url}`);
  const announcedDay = validDate(`${times[0][1]}-${times[0][2].padStart(2, '0')}-${times[0][3].padStart(2, '0')}`, '公告调价日期');
  if (announcedDay !== entry.publishedDate) {
    throw new Error(`山西油价：调价日期与发布日期不符：${entry.url}`);
  }
  return {
    effectiveDate: nextDay(announcedDay),
    publishedDate: entry.publishedDate,
    url: entry.url,
    prices: parsePrices(body, entry.url),
  };
}

module.exports = {
  id: 'shanxi',
  name: '山西',
  sourceName: '山西省发展和改革委员会',
  priceScope: '山西省成品油最高零售价格（元/升）',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today }) {
    if (typeof getText !== 'function') throw new TypeError('山西油价：getText 必须为函数');
    const todayDate = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today, '今天');
    const cutoffDate = new Date(`${todayDate}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - LOOKBACK_DAYS);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const notices = [];
    let pageCount = null;
    let lastDate = null;
    for (let page = 0; page < (pageCount ?? 1); page += 1) {
      const pageUrl = page === 0 ? BASE_URL : `${BASE_URL}index_${page}.shtml`;
      const listing = parseList(await getText(pageUrl), pageUrl, page);
      if (pageCount === null) pageCount = listing.pageCount;
      else if (pageCount !== listing.pageCount) throw new Error('山西油价：采集期间列表分页数量变化');
      for (const item of listing.entries) {
        if (lastDate && item.publishedDate > lastDate) throw new Error('山西油价：公告列表日期顺序异常');
        lastDate = item.publishedDate;
        if (item.publishedDate < cutoff || item.publishedDate > todayDate || item.title !== TITLE) continue;
        const entry = { ...item, url: officialUrl(item.reference, pageUrl) };
        const notice = parseArticle(await getText(entry.url), entry);
        if (notice.effectiveDate <= todayDate) notices.push(notice);
      }
      if (lastDate < cutoff) break;
    }
    if (!notices.length) throw new Error('山西油价：未找到已生效的官方公告');
    notices.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    for (let i = 1; i < notices.length; i += 1) {
      if (notices[i].effectiveDate === notices[i - 1].effectiveDate) {
        throw new Error(`山西油价：生效日期重复：${notices[i].effectiveDate}`);
      }
    }
    return notices;
  },
};
