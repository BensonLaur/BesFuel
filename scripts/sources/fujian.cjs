'use strict';

const HOST = 'fgw.fujian.gov.cn';
const OIL_LIST = `https://${HOST}/ztzl/fjswjj/cpygg/`;
const GENERAL_LIST = `https://${HOST}/zwgk/gsgg/`;
const TITLE = '福建省发展和改革委员会关于成品油价格调整的通告';
const TABLE_TITLE = '福建省汽、柴油最高零售价格和最高批发价格表';
const LOOKBACK_DAYS = 365;

function compact(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|ensp|emsp|#160|#x[aA]0);/gi, ' ')
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/[\s\u00a0\u2000-\u200b\u3000]/g, '');
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`福建油价：${label}无效：${value}`);
  }
  return value;
}

function nextDay(value) {
  const result = new Date(`${value}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + 1);
  return result.toISOString().slice(0, 10);
}

function officialUrl(reference, base, publishedDate) {
  const url = new URL(reference, base);
  const match = url.pathname.match(/^\/(?:zfxxgkzl\/zfxxgkml\/yzdgkdqtxx|zwgk\/gsgg|ztzl\/fjswjj\/cpygg)\/(\d{6})\/t(\d{8})_\d+\.htm$/);
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.username || url.password ||
      url.search || url.hash || !match || match[1] !== publishedDate.slice(0, 7).replace('-', '') ||
      match[2] !== publishedDate.replaceAll('-', '')) {
    throw new Error(`福建油价：公告链接不是预期的官方日期地址：${url.href}`);
  }
  return url.href;
}

function listEntries(html, pageUrl) {
  const start = html.indexOf("<div ms-visible='showStatic'>");
  const end = html.indexOf('<div ms-visible="!showStatic">', start);
  if (start < 0 || end < 0) throw new Error(`福建油价：缺少静态公告列表：${pageUrl}`);
  const list = html.slice(start, end);
  const entries = [];
  for (const item of list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const link = item[1].match(/<a\b[^>]*href="([^"]+)"[^>]*title="([^"]+)"[^>]*>/i);
    const listedDate = item[1].match(/<span\b[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i);
    if (!link || !listedDate) throw new Error(`福建油价：列表条目结构异常：${pageUrl}`);
    const title = compact(link[2]);
    const publishedDate = validDate(listedDate[1], '列表发布日期');
    if (title.includes('成品油价格') && title !== TITLE) {
      throw new Error(`福建油价：未知的成品油价格公告标题：${title}`);
    }
    if (title === TITLE) {
      entries.push({ title, publishedDate, url: officialUrl(link[1], pageUrl, publishedDate) });
    }
  }
  if (!entries.length) throw new Error(`福建油价：列表没有油价公告：${pageUrl}`);
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].publishedDate > entries[i - 1].publishedDate) {
      throw new Error(`福建油价：公告日期顺序异常：${pageUrl}`);
    }
  }
  return entries;
}

function tablePrices(table, url) {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => compact(cell[1])));
  if (rows.length < 2 || rows[0].join('|') !== '油品|最高零售价格|最高批发价格' ||
      rows[1].join('|') !== '元/吨|元/升|元/吨') {
    throw new Error(`福建油价：价格表元/升列标题异常：${url}`);
  }
  const prices = {};
  const grades = [
    ['92', /^车用92号汽油(?:[（(]ⅥB[）)])?$/],
    ['95', /^车用95号汽油(?:[（(]ⅥB[）)])?$/],
    ['diesel', /^车用0号柴油(?:[（(]Ⅵ[）)])?$/],
  ];
  for (const [grade, label] of grades) {
    const matches = rows.filter((row) => label.test(row[0]));
    if (matches.length !== 1 || matches[0].length !== 4) {
      throw new Error(`福建油价：${grade}价格行缺失或重复：${url}`);
    }
    const [, ton, litre, wholesale] = matches[0];
    if (!/^\d+$/.test(ton) || !/^\d+\.\d{1,2}$/.test(litre) ||
        !/^\d+$/.test(wholesale) || Number(ton) < 1000 || Number(ton) > 30000 ||
        Number(litre) < 1 || Number(litre) > 30 || Number(wholesale) > Number(ton)) {
      throw new Error(`福建油价：${grade}元/升价格异常：${url}`);
    }
    prices[grade] = Number(litre);
  }
  return prices;
}

function parsePrices(html, url) {
  const tables = [];
  for (const match of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const before = compact(html.slice(Math.max(0, match.index - 300), match.index));
    if (before.endsWith(TABLE_TITLE)) tables.push(tablePrices(match[0], url));
  }
  if (!tables.length) throw new Error(`福建油价：缺少省级最高零售价格表：${url}`);
  // Government-information pages sometimes embed the same table in two reader tabs.
  for (const prices of tables.slice(1)) {
    if (JSON.stringify(prices) !== JSON.stringify(tables[0])) {
      throw new Error(`福建油价：正文重复价格表内容冲突：${url}`);
    }
  }
  return tables[0];
}

function parseArticle(html, entry) {
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i);
  const published = html.match(/<meta\s+name="PubDate"\s+content="(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}"/i);
  const source = html.match(/<meta\s+name="ContentSource"\s+content="([^"]+)"/i);
  if (!title || compact(title[1]) !== entry.title || !source ||
      compact(source[1]) !== '福建省发展和改革委员会网站') {
    throw new Error(`福建油价：公告标题或来源与列表不符：${entry.url}`);
  }
  if (!published || validDate(published[1], '正文发布日期') !== entry.publishedDate) {
    throw new Error(`福建油价：正文发布日期与列表不符：${entry.url}`);
  }
  const times = [...compact(html).matchAll(/自(\d{4})年(\d{1,2})月(\d{1,2})日24时起执行/g)]
    .map((match) => validDate(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, '执行日期'));
  if (!times.length || times.some((value) => value !== entry.publishedDate)) {
    throw new Error(`福建油价：正文24时执行日期与列表不符：${entry.url}`);
  }
  return {
    effectiveDate: nextDay(entry.publishedDate),
    publishedDate: entry.publishedDate,
    url: entry.url,
    prices: parsePrices(html, entry.url),
  };
}

module.exports = {
  id: 'fujian',
  name: '福建',
  sourceName: '福建省发展和改革委员会',
  priceScope: '福建省汽、柴油最高零售价格（元/升）',
  allowedHostnames: [HOST],
  async collect({ getText, today }) {
    if (typeof getText !== 'function') throw new TypeError('福建油价：getText 必须为函数');
    const todayDate = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today, '今天');
    const cutoffDate = new Date(`${todayDate}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - LOOKBACK_DAYS);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const lists = await Promise.all([OIL_LIST, GENERAL_LIST].map(async (url) =>
      listEntries(await getText(url), url)));
    const byDay = new Map();
    for (const entry of lists.flat()) {
      if (entry.publishedDate < cutoff || entry.publishedDate > todayDate) continue;
      if (!byDay.has(entry.publishedDate)) byDay.set(entry.publishedDate, new Map());
      byDay.get(entry.publishedDate).set(entry.url, entry);
    }
    if (!byDay.size) throw new Error('福建油价：近一年未找到官方公告');
    const notices = [];
    for (const [day, entries] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const copies = [];
      for (const entry of entries.values()) copies.push(parseArticle(await getText(entry.url), entry));
      for (const copy of copies.slice(1)) {
        if (JSON.stringify(copy.prices) !== JSON.stringify(copies[0].prices)) {
          throw new Error(`福建油价：同日官方公告价格冲突：${day}`);
        }
      }
      const preferred = copies.sort((a, b) => {
        const priority = (notice) => notice.url.includes('/zfxxgkzl/') ? 0 :
          notice.url.includes('/zwgk/gsgg/') ? 1 : 2;
        return priority(a) - priority(b) || a.url.localeCompare(b.url);
      })[0];
      if (preferred.effectiveDate <= todayDate) notices.push(preferred);
    }
    if (!notices.length) throw new Error('福建油价：未找到已生效的官方公告');
    return notices;
  },
};
