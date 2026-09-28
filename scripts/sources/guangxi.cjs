'use strict';

const BASE_URL = 'http://fgw.gxzf.gov.cn/xwzx/xwfb/';
const HOSTNAME = 'fgw.gxzf.gov.cn';
const LOOKBACK_DAYS = 180;
const MAX_PAGES = 30;

function compact(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp);|&#(?:160|x[aA]0);/gi, ' ')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`广西油价：${label}无效：${value}`);
  }
  return value;
}

function nextDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function officialUrl(reference, base) {
  const url = new URL(reference, base);
  // The Guangxi commission publishes HTTP canonical URLs; HTTPS currently fails TLS negotiation.
  if (url.protocol !== 'http:' || url.hostname !== HOSTNAME || url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/xwzx\/xwfb\/t\d+\.shtml$/.test(url.pathname)) {
    throw new Error(`广西油价：公告不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function listEntries(html, pageUrl, page) {
  const pagination = html.match(/createPageHTML\(\s*(\d+)\s*,\s*(\d+)\s*,\s*"index"\s*,\s*"shtml"\s*,\s*"\d+"\s*\)/);
  const pageCount = Number(pagination?.[1]);
  if (!pagination || pageCount < 1 || pageCount > MAX_PAGES || Number(pagination[2]) !== page) {
    throw new Error(`广西油价：公告列表分页异常：${pageUrl}`);
  }
  const lists = [...html.matchAll(/<ul\s+class="more-list"[^>]*>([\s\S]*?)<\/ul>/gi)];
  if (!lists.length) throw new Error(`广西油价：公告列表缺失：${pageUrl}`);
  const entries = [];
  for (const list of lists) {
    for (const item of list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const date = item[1].match(/<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i);
      const anchor = item[1].match(/<a\b[^>]*\bhref="([^"]+)"[^>]*\btitle="([^"]+)"[^>]*>/i);
      if (!date || !anchor) throw new Error(`广西油价：公告列表条目结构异常：${pageUrl}`);
      entries.push({
        publishedDate: validDate(date[1], '列表发布日期'),
        title: compact(anchor[2]),
        reference: anchor[1],
      });
    }
  }
  if (!entries.length) throw new Error(`广西油价：公告列表为空：${pageUrl}`);
  return { pageCount, entries };
}

function priceRows(body, url) {
  if (!compact(body).includes('广西市场成品油最高销售价格表')) {
    throw new Error(`广西油价：缺少自治区最高销售价格表：${url}`);
  }
  const tables = [...body.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tables.length !== 1) throw new Error(`广西油价：价格表数量异常：${url}`);
  const rows = [...tables[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => compact(cell[1])));
  if (rows.length !== 6 || rows[0].join('|') !== '项目||最高批发价格|最高零售价格(元)' ||
      rows[1].join('|') !== '品种|规格|元/吨|吨|升') {
    throw new Error(`广西油价：价格表列标题或结构异常：${url}`);
  }
  const definitions = [
    [rows[2], 5, '国VIB车用汽油', '89#', null],
    [rows[3], 4, null, '92#', '92'],
    [rows[4], 4, null, '95#', '95'],
    [rows[5], 5, '国VI车用柴油', '0#', 'diesel'],
  ];
  const prices = {};
  for (const [row, length, group, label, grade] of definitions) {
    if (row.length !== length || (group && row[0] !== group) || row[length - 4] !== label ||
        !/^\d+$/.test(row[length - 3]) || !/^\d+$/.test(row[length - 2]) ||
        !/^\d+\.\d{2}$/.test(row[length - 1]) ||
        Number(row[length - 2]) <= Number(row[length - 3]) ||
        Number(row[length - 1]) < 1 || Number(row[length - 1]) > 30) {
      throw new Error(`广西油价：${label}元/升价格行异常：${url}`);
    }
    if (grade) prices[grade] = Number(row[length - 1]);
  }
  return prices;
}

function article(entry, html) {
  const metaTitle = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i);
  const heading = html.match(/<h1>\s*([^<]+)\s*<\/h1>/i);
  const metaDate = html.match(/<meta\s+name="PubDate"\s+content="(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}"/i);
  const metaUrl = html.match(/<meta\s+name="Url"\s+content="([^"]+)"/i);
  const source = html.match(/<meta\s+name="ContentSource"\s+content="([^"]+)"/i);
  if (!metaTitle || !heading || compact(metaTitle[1]) !== entry.title ||
      compact(heading[1]) !== entry.title || !metaDate ||
      validDate(metaDate[1], '公告发布日期') !== entry.publishedDate ||
      !metaUrl || officialUrl(metaUrl[1], BASE_URL) !== entry.url ||
      !source || compact(source[1]) !== '价格和收费管理处') {
    throw new Error(`广西油价：公告标题、日期、来源或官网地址与列表不符：${entry.url}`);
  }
  const start = html.indexOf('<!-- 正文s -->');
  const end = html.indexOf('<!-- 正文e -->', start);
  if (start < 0 || end < 0) throw new Error(`广西油价：缺少公告正文：${entry.url}`);
  const body = html.slice(start, end);
  const text = compact(body);
  const announced = [...text.matchAll(/执行时间[:：]?\(?((?:20)\d{2})年(\d{1,2})月(\d{1,2})日24时起\)?/g)];
  if (announced.length !== 1) throw new Error(`广西油价：价格表执行时间缺失或重复：${entry.url}`);
  const publishedDate = validDate(`${announced[0][1]}-${announced[0][2].padStart(2, '0')}-${announced[0][3].padStart(2, '0')}`, '价格表执行日期');
  if (publishedDate !== entry.publishedDate) {
    throw new Error(`广西油价：价格表执行日期与公告日期不符：${entry.url}`);
  }
  const prices = priceRows(body, entry.url);
  const previousPrices = {};
  for (const [grade, label] of [['92', '92号汽油'], ['95', '95号汽油'], ['diesel', '0号车用柴油']]) {
    const values = [...text.matchAll(new RegExp(`${label}从(\\d+(?:\\.\\d{1,2})?)元/升调整到(\\d+(?:\\.\\d{1,2})?)元/升`, 'g'))];
    if (values.length !== 1 || Number(values[0][2]) !== prices[grade]) {
      throw new Error(`广西油价：${label}正文与元/升价格表不符：${entry.url}`);
    }
    previousPrices[grade] = Number(values[0][1]);
  }
  return { effectiveDate: nextDay(publishedDate), publishedDate, url: entry.url, prices, previousPrices };
}

module.exports = {
  id: 'guangxi',
  name: '广西',
  sourceName: '广西壮族自治区发展和改革委员会',
  priceScope: '广西市场成品油最高零售价格（元/升）',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today }) {
    if (typeof getText !== 'function') throw new TypeError('广西油价：getText 必须为函数');
    const todayDate = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today, '今天');
    const cutoffDate = new Date(`${todayDate}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - LOOKBACK_DAYS);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const notices = [];
    let pageCount = null;
    let lastDate = null;
    for (let page = 0; page < (pageCount ?? 1); page += 1) {
      const pageUrl = page === 0 ? BASE_URL : `${BASE_URL}index_${page}.shtml`;
      const listing = listEntries(await getText(pageUrl), pageUrl, page);
      if (pageCount === null) pageCount = listing.pageCount;
      else if (pageCount !== listing.pageCount) throw new Error('广西油价：采集期间分页数量变化');
      for (const entry of listing.entries) {
        if (lastDate && entry.publishedDate > lastDate) {
          throw new Error('广西油价：公告列表日期顺序异常');
        }
        lastDate = entry.publishedDate;
        if (entry.publishedDate < cutoff || entry.publishedDate > todayDate ||
            !entry.title.includes('广西成品油价格')) continue;
        const titleDate = entry.title.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日24时起广西成品油价格(?:调整|下调|按机制调整)$/);
        if (!titleDate || validDate(`${titleDate[1] || entry.publishedDate.slice(0, 4)}-${titleDate[2].padStart(2, '0')}-${titleDate[3].padStart(2, '0')}`, '标题日期') !== entry.publishedDate) {
          throw new Error(`广西油价：未知公告标题或日期冲突：${entry.title}`);
        }
        const item = { ...entry, url: officialUrl(entry.reference, pageUrl) };
        const notice = article(item, await getText(item.url));
        if (notice.effectiveDate <= todayDate) notices.push(notice);
      }
      if (lastDate < cutoff) break;
    }
    if (!notices.length) throw new Error('广西油价：未找到已生效的官方公告');
    notices.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    for (let index = 1; index < notices.length; index += 1) {
      const older = notices[index - 1];
      const newer = notices[index];
      if (newer.effectiveDate === older.effectiveDate) {
        throw new Error(`广西油价：重复生效日期：${newer.effectiveDate}`);
      }
      for (const grade of ['92', '95', 'diesel']) {
        if (newer.previousPrices[grade] !== older.prices[grade]) {
          throw new Error(`广西油价：${grade} 号价格历史不连续：${newer.url}`);
        }
      }
    }
    return notices.map(({ previousPrices, ...notice }) => notice);
  },
};
