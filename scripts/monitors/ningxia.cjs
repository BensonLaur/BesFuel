'use strict';

const HOSTNAME = 'fzggw.nx.gov.cn';
const LIST_URL = `https://${HOSTNAME}/tzgg/`;
const TITLE = /^宁夏成品油价格调整公告（(20\d{2})年第(\d{2})号）$/;
const ARTICLE_PATH = /^\/tzgg\/(20\d{2})(\d{2})\/t(20\d{2})(\d{2})(\d{2})_\d+\.html$/;

function validDate(value, label) {
  const day = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
    throw new Error(`宁夏油价公告：${label}无效：${value}`);
  }
  return value;
}

function dateFromParts(year, month, day, label) {
  return validDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, label);
}

function nextDate(value) {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function officialUrl(reference, postedDate) {
  const url = new URL(reference, LIST_URL);
  const parts = url.pathname.match(ARTICLE_PATH);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME ||
      url.username || url.password || url.search || url.hash || !parts) {
    throw new Error(`宁夏油价公告：不是预期的自治区发改委地址：${url.href}`);
  }
  if (dateFromParts(parts[3], parts[4], parts[5], '链接日期') !== postedDate ||
      `${parts[1]}${parts[2]}` !== `${parts[3]}${parts[4]}`) {
    throw new Error(`宁夏油价公告：链接日期与列表日期不符：${url.href}`);
  }
  return url.href;
}

function latestEntry(html) {
  const block = html.match(/<ul class="newslist">([\s\S]*?)<\/ul>/i)?.[1];
  if (!block) throw new Error('宁夏油价公告：官网公告列表结构已变化');
  const entries = [];
  for (const item of block.matchAll(/<li>\s*<a href="([^"]+)">([^<]+)<\/a><span class="time">(\d{4}-\d{2}-\d{2})<\/span>\s*<\/li>/gi)) {
    if (!item[2].includes('成品油价格调整公告')) continue;
    const title = item[2].match(TITLE);
    if (!title) throw new Error(`宁夏油价公告：未知公告标题：${item[2]}`);
    const postedDate = validDate(item[3], '列表日期');
    if (!postedDate.startsWith(title[1])) throw new Error('宁夏油价公告：年度编号与列表日期不符');
    entries.push({
      title: item[2],
      year: title[1],
      number: Number(title[2]),
      postedDate,
      url: officialUrl(item[1], postedDate),
    });
  }
  if (!entries.length || entries.length !== (block.match(/成品油价格调整公告/g) || []).length) {
    throw new Error('宁夏油价公告：官网列表缺少可核验调价公告');
  }
  entries.sort((a, b) => b.postedDate.localeCompare(a.postedDate));
  if (entries.length > 1 && entries[0].postedDate === entries[1].postedDate) {
    throw new Error(`宁夏油价公告：同日公告不唯一：${entries[0].postedDate}`);
  }
  return entries[0];
}

function cellText(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, '').replace(/\s|\u00a0/g, '');
}

function parsePrices(html) {
  const prices = {};
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(cell => cellText(cell[1]));
    const labels = {
      '92号车用汽油（106%）': '92',
      '95号车用汽油（112%）': '95',
      '0号车用柴油（100%）': 'diesel',
    };
    for (let index = 0; index < cells.length; index += 1) {
      const grade = labels[cells[index]];
      if (!grade) continue;
      if (grade in prices || !/^\d{4,5}$/.test(cells[index + 1] || '') ||
          !/^\d{1,2}\.\d{2}$/.test(cells[index + 2] || '')) {
        throw new Error(`宁夏油价公告：${grade} 价格表列无效`);
      }
      prices[grade] = Number(cells[index + 2]);
    }
  }
  if (Object.keys(prices).length !== 3 ||
      Object.values(prices).some(price => price < 4 || price > 20)) {
    throw new Error('宁夏油价公告：缺少可信的 92、95 或 0 号元/升价格');
  }
  return prices;
}

function parseArticle(html, entry) {
  const title = html.match(/<div class="xilan-title">\s*([^<]+?)\s*<\/div>/i)?.[1]?.trim();
  const metadataTitle = html.match(/<meta name="ArticleTitle" content="([^"]+)">/i)?.[1];
  const postedDate = html.match(/<meta name="PubDate" content="(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}">/i)?.[1];
  if (title !== entry.title || metadataTitle !== entry.title ||
      postedDate !== entry.postedDate ||
      !/<meta name="ContentSource" content="自治区发展和改革委员会"\s*\/>/i.test(html)) {
    throw new Error(`宁夏油价公告：正文标题、发布日期或来源与列表不符：${entry.url}`);
  }
  const text = cellText(html);
  const signature = text.match(/宁夏回族自治区发展和改革委员会(20\d{2})年(\d{1,2})月(\d{1,2})日宁夏市场成品油最高零售价格表/);
  const effective = text.match(/自(20\d{2})年(\d{1,2})月(\d{1,2})日24时起执行/);
  if (!signature || !effective || !text.includes('最高零售价元/吨元/升')) {
    throw new Error(`宁夏油价公告：正文署名、生效时间或升价表缺失：${entry.url}`);
  }
  const publishedDate = dateFromParts(signature[1], signature[2], signature[3], '正文署名日期');
  const effectiveBase = dateFromParts(effective[1], effective[2], effective[3], '生效日期');
  // 官网曾在 9 月 15 日补登署名 9 月 11 日的公告，采用署名日核对生效日。
  if (publishedDate !== effectiveBase || publishedDate > entry.postedDate ||
      (Date.parse(entry.postedDate) - Date.parse(publishedDate)) / 86400000 > 7) {
    throw new Error(`宁夏油价公告：署名、上站与生效日期不符：${entry.url}`);
  }
  return {
    url: entry.url,
    publishedDate,
    effectiveDate: nextDate(effectiveBase),
    prices: parsePrices(html),
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'ningxia',
  name: '宁夏',
  sourceName: '宁夏回族自治区发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText } = {}) {
    if (typeof getText !== 'function') throw new TypeError('宁夏油价公告：需要官方 HTML 读取器');
    const entry = latestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
