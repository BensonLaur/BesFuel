'use strict';

const HOST = 'fzggw.jiangsu.gov.cn';
const LIST_URL = `https://${HOST}/col/col91435/index.html`;
const TITLE = /^江苏省成品油价格调整公告（(\d{4})年第(\d+)号）$/;
const TABLE_TITLE = '江苏省汽、柴油最高零售批发价格表';
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
    throw new Error(`江苏油价：${label}无效：${value}`);
  }
  return value;
}

function nextDay(value) {
  const result = new Date(`${value}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + 1);
  return result.toISOString().slice(0, 10);
}

function officialUrl(reference, publishedDate) {
  const url = new URL(reference, LIST_URL);
  const match = url.pathname.match(/^\/art\/(\d{4})\/(\d{1,2})\/(\d{1,2})\/art_91435_\d+\.html$/);
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.username || url.password ||
      url.search || url.hash || !match ||
      `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` !== publishedDate) {
    throw new Error(`江苏油价：公告不是预期的官网日期地址：${url.href}`);
  }
  return url.href;
}

function listEntries(html) {
  const records = [...html.matchAll(/<record><!\[CDATA\[([\s\S]*?)\]\]><\/record>/g)];
  if (!records.length) throw new Error('江苏油价：官网公告列表为空');
  const byUrl = new Map();
  for (const record of records) {
    const link = record[1].match(/<a\b[^>]*title='([^']+)'[^>]*href="([^"]+)"[^>]*>/i);
    const listedDate = record[1].match(/<span\s+class="bt-list-time">(\d{4}-\d{2}-\d{2})<\/span>/i);
    if (!link || !listedDate) throw new Error('江苏油价：官网列表条目结构异常');
    const title = compact(link[1]);
    const publishedDate = validDate(listedDate[1], '列表发布日期');
    const serial = title.match(TITLE);
    if (!serial || Number(serial[1]) !== Number(publishedDate.slice(0, 4)) ||
        Number(serial[2]) < 1 || Number(serial[2]) > 50) {
      throw new Error(`江苏油价：公告标题或期号异常：${title}`);
    }
    const url = officialUrl(link[2], publishedDate);
    const entry = { title, publishedDate, serial: Number(serial[2]), url };
    const old = byUrl.get(url);
    if (old && (old.title !== title || old.publishedDate !== publishedDate)) {
      throw new Error(`江苏油价：同一公告在列表中冲突：${url}`);
    }
    byUrl.set(url, entry);
  }
  const entries = [...byUrl.values()];
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].publishedDate >= entries[i - 1].publishedDate) {
      throw new Error('江苏油价：官网公告日期顺序或同日记录异常');
    }
    if (entries[i].publishedDate.slice(0, 4) === entries[i - 1].publishedDate.slice(0, 4) &&
        entries[i - 1].serial !== entries[i].serial + 1) {
      throw new Error('江苏油价：官网公告期号不连续');
    }
  }
  return entries;
}

function priceTable(html, url) {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
  if (tables.length !== 1 || !compact(html.slice(0, tables[0].index)).includes(TABLE_TITLE) ||
      !compact(html.slice(0, tables[0].index)).includes('单位：元/吨，元/升')) {
    throw new Error(`江苏油价：省级元/升价格表缺失或重复：${url}`);
  }
  const rows = [...tables[0][0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => compact(cell[1])));
  if (rows.length < 2 || rows[0].join('|') !== '项目|最高零售价格|最高批发价格' ||
      rows[1].join('|') !== '吨价|升价|吨价') {
    throw new Error(`江苏油价：表头不能证明升价列：${url}`);
  }
  const prices = {};
  for (const [grade, name] of [
    ['92', /^92#国(?:VI|Ⅵ)B汽油$/],
    ['95', /^95#国(?:VI|Ⅵ)B汽油$/],
    ['diesel', /^0#国(?:VI|Ⅵ)柴油$/],
  ]) {
    const matches = rows.filter((row) => name.test(row[0]));
    if (matches.length !== 1 || matches[0].length !== 4) {
      throw new Error(`江苏油价：${grade}价格行缺失或重复：${url}`);
    }
    const [, ton, litre, wholesale] = matches[0];
    if (!/^\d+$/.test(ton) || !/^\d+\.\d{1,2}$/.test(litre) ||
        !/^\d+$/.test(wholesale) || Number(ton) < 1000 || Number(ton) > 30000 ||
        Number(litre) < 1 || Number(litre) > 30 || Number(wholesale) > Number(ton)) {
      throw new Error(`江苏油价：${grade}升价格式或范围异常：${url}`);
    }
    prices[grade] = Number(litre);
  }
  return prices;
}

function parseArticle(html, entry) {
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i);
  const published = html.match(/<meta\s+name="PubDate"\s+content="(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}"/i);
  const source = html.match(/<meta\s+name="ContentSource"\s+content="([^"]+)"/i);
  if (!title || compact(title[1]) !== entry.title || !source ||
      compact(source[1]) !== '价格管理和成本监审处') {
    throw new Error(`江苏油价：公告标题或发布单位与列表不符：${entry.url}`);
  }
  if (!published || validDate(published[1], '正文发布日期') !== entry.publishedDate) {
    throw new Error(`江苏油价：正文发布日期与列表不符：${entry.url}`);
  }
  const start = html.indexOf('<!--ZJEG_RSS.content.begin-->');
  const end = html.indexOf('<!--ZJEG_RSS.content.end-->', start);
  if (start < 0 || end < 0) throw new Error(`江苏油价：公告正文缺失：${entry.url}`);
  const body = html.slice(start, end);
  const executionDays = [...compact(body).matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日24时起执行/g)]
    .map((match) => validDate(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`, '执行日期'));
  if (executionDays.length < 2 || executionDays.some((day) => day !== entry.publishedDate)) {
    throw new Error(`江苏油价：公告正文与表格的24时执行日期不一致：${entry.url}`);
  }
  return {
    effectiveDate: nextDay(entry.publishedDate),
    publishedDate: entry.publishedDate,
    url: entry.url,
    prices: priceTable(body, entry.url),
  };
}

module.exports = {
  id: 'jiangsu',
  name: '江苏',
  sourceName: '江苏省发展和改革委员会',
  priceScope: '江苏省汽、柴油最高零售价格（元/升）',
  allowedHostnames: [HOST],
  async collect({ getText, today }) {
    if (typeof getText !== 'function') throw new TypeError('江苏油价：getText 必须为函数');
    const todayDate = validDate(today instanceof Date ? today.toISOString().slice(0, 10) : today, '今天');
    const cutoffDate = new Date(`${todayDate}T00:00:00Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - LOOKBACK_DAYS);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const entries = listEntries(await getText(LIST_URL));
    if (entries.at(-1).publishedDate > cutoff) {
      throw new Error('江苏油价：官网列表未覆盖近一年，不能确认历史完整');
    }
    const notices = [];
    for (const entry of entries.filter((item) => item.publishedDate >= cutoff &&
      item.publishedDate <= todayDate).reverse()) {
      const notice = parseArticle(await getText(entry.url), entry);
      if (notice.effectiveDate <= todayDate) notices.push(notice);
    }
    if (!notices.length) throw new Error('江苏油价：近一年未找到已生效的官方公告');
    return notices;
  },
};
