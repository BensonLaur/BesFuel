'use strict';

const HOSTNAME = 'fgw.nmg.gov.cn';
const LIST_URL = 'https://fgw.nmg.gov.cn/ywgz/jfgz/cpyjg/index.html';
const ARTICLE_PATH = /^\/ywgz\/jfgz\/cpyjg\/(\d{6})\/t(\d{8})_\d+\.html$/;
const NOTICE_TITLE = /^我区成品油价格(?:按机制)?调整$/;
const WEST_HEADING = '内蒙古自治区西部价区汽、柴油最高批发、零售价格表';
const EAST_HEADING = '内蒙古自治区东部价区汽、柴油最高批发、零售价格表';
const ZONE_SCOPE = '西部价区包括呼和浩特市、包头市、乌兰察布市、鄂尔多斯市、巴彦淖尔市、乌海市和阿拉善盟';

function chinaDate() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`内蒙古西部价区：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const day = new Date(`${value}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function chineseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function plain(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[\s\u00a0\u3000]/g, '');
}

function officialUrl(reference) {
  const url = new URL(reference, LIST_URL);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.port ||
      url.username || url.password || url.search || url.hash || !ARTICLE_PATH.test(url.pathname)) {
    throw new Error(`内蒙古西部价区：公告不是预期的自治区发改委地址：${url.href}`);
  }
  return url.href;
}

function listing(html) {
  const page = html.match(/var\s+currentPage\s*=\s*(\d+)/);
  const total = html.match(/var\s+countPage\s*=\s*(\d+)/);
  if (!page || Number(page[1]) !== 0 || !total || Number(total[1]) < 1) {
    throw new Error('内蒙古西部价区：官网公告列表分页异常');
  }
  const list = html.match(/<ul\s+class="newsList"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!list) throw new Error('内蒙古西部价区：官网成品油公告列表缺失');
  const entries = [];
  for (const item of list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const anchor = item[1].match(/<a\s+href="([^"]+)"[^>]*\btitle="([^"]+)"[^>]*>/i);
    const date = item[1].match(/<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i);
    if (!anchor || !date) throw new Error('内蒙古西部价区：官网列表条目结构变化');
    const title = anchor[2].trim();
    if (!title.includes('成品油价格')) continue;
    if (!NOTICE_TITLE.test(title)) throw new Error(`内蒙古西部价区：未知油价公告标题：${title}`);
    const publishedDate = validDate(date[1], '列表日期');
    const url = officialUrl(anchor[1]);
    const path = new URL(url).pathname.match(ARTICLE_PATH);
    if (path[1] !== publishedDate.slice(0, 4) + publishedDate.slice(5, 7) ||
        path[2] !== publishedDate.replace(/-/g, '')) {
      throw new Error(`内蒙古西部价区：公告路径与列表日期不符：${url}`);
    }
    entries.push({ title, publishedDate, url });
  }
  if (!entries.length) throw new Error('内蒙古西部价区：官网列表没有油价公告');
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index].publishedDate >= entries[index - 1].publishedDate) {
      throw new Error('内蒙古西部价区：公告列表日期顺序或唯一性异常');
    }
  }
  return entries;
}

function priceRows(table, day) {
  const rows = [...table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map(row =>
    [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => plain(cell[1])));
  if (rows.length < 9 || rows[0][0] !== '品种' ||
      !rows[0].includes('最高零售价') ||
      !rows.some(row => row.includes('元/吨') && row.includes('元/升'))) {
    throw new Error(`内蒙古西部价区：价格表表头或单位异常：${day}`);
  }
  const prices = {};
  const tonPrices = {};
  for (const [grade, label] of [['92', '92号'], ['95', '95号'], ['diesel', '0号']]) {
    const matches = rows.filter(row => row.some(cell => cell.startsWith(label)));
    if (matches.length !== 1) throw new Error(`内蒙古西部价区：${grade} 价格行缺失或重复：${day}`);
    const row = matches[0];
    const index = row.findIndex(cell => cell.startsWith(label));
    const values = row.slice(index);
    const [name, ton, litre, delivered, undelivered] = values;
    if (values.length !== 5 || !name.startsWith(label) ||
        !/^\d{4,5}$/.test(ton) || !/^\d{1,2}\.\d{2}$/.test(litre) ||
        !/^\d{4,5}$/.test(delivered) || !/^\d{4,5}$/.test(undelivered) ||
        Number(litre) < 1 || Number(litre) > 30 ||
        Number(ton) <= Number(delivered) || Number(delivered) <= Number(undelivered)) {
      throw new Error(`内蒙古西部价区：${grade} 元/升价格行异常：${day}`);
    }
    prices[grade] = Number(litre);
    tonPrices[grade] = Number(ton);
  }
  if (!(prices['95'] > prices['92'] && prices['92'] > prices.diesel)) {
    throw new Error(`内蒙古西部价区：油号价格关系异常：${day}`);
  }
  return { prices, tonPrices };
}

function article(html, entry) {
  const site = html.match(/<meta\s+name="SiteName"\s+content="([^"]+)"/i)?.[1];
  const source = html.match(/<meta\s+name="ContentSource"\s+content="([^"]+)"/i)?.[1];
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content=['"]([^'"]+)['"]/i)?.[1];
  const heading = html.match(/<h1\s+class="xl-title">\s*([^<]+)\s*<\/h1>/i)?.[1];
  const pub = html.match(/<meta\s+name="PubDate"\s+content="(\d{4})年(\d{2})月(\d{2})日\s+\d{2}:\d{2}"/i);
  if (site !== '内蒙古自治区发展和改革委员会' || source !== site ||
      title !== entry.title || heading?.trim() !== entry.title || !pub ||
      validDate(`${pub[1]}-${pub[2]}-${pub[3]}`, '网页发布日期') !== entry.publishedDate) {
    throw new Error(`内蒙古西部价区：正文官网、标题或日期与列表不符：${entry.url}`);
  }
  const start = html.indexOf('<div class="xl-cont">');
  const end = html.indexOf('<div class="xl-fjxz">', start);
  if (start < 0 || end < 0) throw new Error(`内蒙古西部价区：公告正文结构异常：${entry.url}`);
  const body = html.slice(start, end);
  const text = plain(body);
  const dateText = chineseDate(entry.publishedDate);
  if (!text.includes(`自${dateText}24时起`) || !text.includes(ZONE_SCOPE)) {
    throw new Error(`内蒙古西部价区：正文生效日期或价区覆盖范围异常：${entry.url}`);
  }
  const tables = [...body.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];
  if (tables.length !== 2) throw new Error(`内蒙古西部价区：东西部价格表数量异常：${entry.url}`);
  const beforeWest = plain(body.slice(0, tables[0].index));
  const beforeEast = plain(body.slice(tables[0].index + tables[0][0].length, tables[1].index));
  if (!beforeWest.includes(`${WEST_HEADING}（自${dateText}24时起执行）`) ||
      !beforeEast.includes(`${EAST_HEADING}（自${dateText}24时起执行）`)) {
    throw new Error(`内蒙古西部价区：附表价区顺序或日期异常：${entry.url}`);
  }
  const west = priceRows(tables[0][0], entry.publishedDate);
  const east = priceRows(tables[1][0], entry.publishedDate);
  for (const grade of ['92', '95', 'diesel']) {
    if (west.tonPrices[grade] !== east.tonPrices[grade]) {
      throw new Error(`内蒙古西部价区：${grade} 东西部官方吨价不一致：${entry.url}`);
    }
  }
  return { publishedDate: entry.publishedDate, effectiveDate: nextDate(entry.publishedDate),
    url: entry.url, prices: west.prices };
}

module.exports = {
  id: 'inner-mongolia-west',
  name: '内蒙古西部价区',
  sourceName: '内蒙古自治区发展和改革委员会',
  priceScope: '内蒙古自治区西部价区（呼和浩特市、包头市、乌兰察布市、鄂尔多斯市、巴彦淖尔市、乌海市、阿拉善盟）汽、柴油最高零售价格（元/升）；加油站实付价可能不同。',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today = chinaDate() } = {}) {
    if (typeof getText !== 'function') throw new TypeError('内蒙古西部价区：需要官方网页读取器');
    const asOf = validDate(today, '核对日期');
    const recent = listing(await getText(LIST_URL))
      .filter(entry => nextDate(entry.publishedDate) <= asOf)
      .slice(0, 12).reverse();
    if (!recent.length) throw new Error('内蒙古西部价区：官网列表没有已生效调价公告');
    const notices = [];
    for (const entry of recent) notices.push(article(await getText(entry.url), entry));
    return notices;
  },
  article,
};
