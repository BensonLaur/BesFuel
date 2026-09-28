'use strict';

const BASE_URL = 'https://fgw.beijing.gov.cn/fgwzwgk/2024zcwj/bwqtwj/';
const MAX_PAGES = 100;
// 2026-04-21 的官方“实施日期”与正文“24时起”冲突，历史回溯只纳入近期一致的公告。
const LOOKBACK_DAYS = 150;

function plainText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function requireDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`北京油价：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function metadata(html, label) {
  const match = html.match(new RegExp(`<li>\\s*\\[${label}\\]\\s*<span>([^<]*)<\\/span>`, 'i'));
  if (!match) throw new Error(`北京油价：缺少${label}`);
  return requireDate(match[1].trim(), label);
}

function listEntries(html, pageUrl) {
  const match = html.match(/var\s+countPage\s*=\s*(\d+)/);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > MAX_PAGES) {
    throw new Error(`北京油价：列表分页数量异常：${pageUrl}`);
  }
  const entries = [];
  const pattern = /<li>\s*<a\s+href="(\.\/\d{6}\/t\d+_\d+\.htm)"\s+title="([^"]+)"[\s\S]{0,500}?<\/a>\s*<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>\s*<\/li>/g;
  for (const item of html.matchAll(pattern)) {
    const title = plainText(item[2]).replace(/^（失效）/, '');
    entries.push({
      url: new URL(item[1], pageUrl).href,
      title,
      publishedDate: requireDate(item[3], '列表发布日期'),
    });
  }
  if (!entries.length) throw new Error(`北京油价：列表没有可解析的公告：${pageUrl}`);
  return { pageCount: Number(match[1]), entries };
}

function articlePrices(html) {
  const contentStart = html.indexOf('class="xl_content"');
  if (contentStart < 0) throw new Error('北京油价：缺少公告正文');
  const tables = [...html.slice(contentStart).matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]
    .map((match) => match[0])
    .filter((table) => plainText(table).includes('北京市汽、柴油价格表') ||
      (plainText(table).includes('最高零售价格') && plainText(table).includes('元/升')));
  if (tables.length !== 1) throw new Error(`北京油价：价格表数量异常：${tables.length}`);
  const rows = [...tables[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => plainText(cell[1])));
  if (rows.length < 5 || !rows[0].includes('最高零售价格') ||
      rows[1].at(-1) !== '元/升') {
    throw new Error('北京油价：价格表列标题异常');
  }
  const prices = {};
  for (const [grade, label] of [['92', '92号汽油'], ['95', '95号汽油'], ['diesel', '0号柴油']]) {
    const matchingRows = rows.filter((row) => row[0] === label);
    if (matchingRows.length !== 1 || matchingRows[0].length !== 5) {
      throw new Error(`北京油价：${label}价格行缺失或不唯一`);
    }
    const value = matchingRows[0][4];
    if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0) {
      throw new Error(`北京油价：${label}元/升数值异常：${value}`);
    }
    prices[grade] = Number(value);
  }
  return prices;
}

function parseArticle(html, entry) {
  const titleMatch = html.match(/<div\s+class="xl_title">([^<]+)<\/div>/);
  const title = titleMatch && plainText(titleMatch[1]).replace(/^（失效）/, '');
  if (title !== entry.title) throw new Error(`北京油价：公告标题与列表不符：${entry.url}`);
  const publishedDate = metadata(html, '发布日期');
  const effectiveDate = metadata(html, '实施日期');
  if (publishedDate !== entry.publishedDate) {
    throw new Error(`北京油价：发布日期与列表不符：${entry.url}`);
  }
  const text = plainText(html.slice(html.indexOf('class="xl_content"')));
  const time = text.match(/本市汽、柴油最高零售价格自(\d{4})年(\d{1,2})月(\d{1,2})日24时起/);
  if (!time) throw new Error(`北京油价：缺少明确的24时生效时间：${entry.url}`);
  const announcedDay = requireDate(`${time[1]}-${time[2].padStart(2, '0')}-${time[3].padStart(2, '0')}`, '正文调价日期');
  if (nextDate(announcedDay) !== effectiveDate) {
    throw new Error(`北京油价：实施日期与正文生效时间不符：${entry.url}`);
  }
  const prices = articlePrices(html);
  for (const [grade, label] of [['92', '92号汽油'], ['95', '95号汽油'], ['diesel', '0号柴油']]) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const changes = [...text.matchAll(new RegExp(`${escaped}由每升\\d+(?:\\.\\d+)?元调整为(\\d+(?:\\.\\d+)?)元`, 'g'))];
    if (changes.length !== 1 || Number(changes[0][1]) !== prices[grade]) {
      throw new Error(`北京油价：${label}正文与元/升价格表不符：${entry.url}`);
    }
  }
  return { effectiveDate, publishedDate, url: entry.url, prices };
}

module.exports = {
  id: 'beijing',
  name: '北京',
  sourceName: '北京市发展和改革委员会',
  priceScope: '北京市汽、柴油最高零售价格（元/升）',
  allowedHostnames: ['fgw.beijing.gov.cn'],
  async collect({ getText, today }) {
    if (typeof getText !== 'function') throw new TypeError('北京油价：getText 必须为函数');
    const todayDate = requireDate(today instanceof Date ? today.toISOString().slice(0, 10) : today, '今天');
    const cutoffDay = new Date(`${todayDate}T00:00:00Z`);
    cutoffDay.setUTCDate(cutoffDay.getUTCDate() - LOOKBACK_DAYS);
    const cutoff = cutoffDay.toISOString().slice(0, 10);
    const announcements = [];
    let lastDate = null;
    let pageCount = null;
    for (let page = 0; page < (pageCount ?? 1); page += 1) {
      const pageUrl = page === 0 ? BASE_URL : `${BASE_URL}index_${page}.htm`;
      const listing = listEntries(await getText(pageUrl), pageUrl);
      if (pageCount === null) pageCount = listing.pageCount;
      else if (listing.pageCount !== pageCount) throw new Error('北京油价：分页数量在采集过程中变化');
      for (const entry of listing.entries) {
        if (lastDate && entry.publishedDate > lastDate) throw new Error('北京油价：公告列表日期顺序异常');
        lastDate = entry.publishedDate;
        if (entry.publishedDate < cutoff) continue;
        if (!/^本市成品油价格(?:调整|按机制(?:上调|下调))$/.test(entry.title)) {
          if (entry.title.startsWith('本市成品油价格')) {
            throw new Error(`北京油价：未知公告标题：${entry.title}`);
          }
          continue;
        }
        const result = parseArticle(await getText(entry.url), entry);
        if (result.effectiveDate <= todayDate) announcements.push(result);
      }
      if (lastDate < cutoff) break;
    }
    if (!announcements.length) throw new Error('北京油价：未找到已生效的官方公告');
    announcements.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    for (let i = 1; i < announcements.length; i += 1) {
      if (announcements[i].effectiveDate === announcements[i - 1].effectiveDate) {
        throw new Error(`北京油价：生效日期重复：${announcements[i].effectiveDate}`);
      }
    }
    return announcements;
  },
};
