'use strict';

const LIST_URL = 'https://fgw.guizhou.gov.cn/fggz/tzgg/';
const HOSTNAME = 'fgw.guizhou.gov.cn';

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`贵州一价区公告：${label}无效：${value}`);
  }
  return value;
}

function officialUrl(reference, base, pattern, label) {
  const url = new URL(reference, base);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.port ||
      url.username || url.password || url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error(`贵州一价区公告：${label}不是预期的官网地址：${url.href}`);
  }
  return url.href;
}

function newestEntry(html) {
  const list = html.match(/<ul\s+class="NewsList"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!list) throw new Error('贵州一价区公告：缺少省发改委公告列表');
  const entries = [];
  for (const item of list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const anchor = item[1].match(/<a\b[^>]*\btitle="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*>/i);
    const date = item[1].match(/<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/i);
    if (!anchor || !date) {
      if (item[1].includes('成品油')) throw new Error('贵州一价区公告：油价列表条目结构变化');
      continue;
    }
    const title = anchor[1].trim();
    if (!title.includes('贵州成品油价格')) continue;
    const publishedDate = validDate(date[1], '列表发布日期');
    const titleDate = title.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日24时起贵州成品油价格(?:调整|上调|下调|按机制(?:调整|上调|下调))$/);
    if (!titleDate || validDate(`${titleDate[1]}-${titleDate[2].padStart(2, '0')}-${titleDate[3].padStart(2, '0')}`, '公告标题日期') !== publishedDate) {
      throw new Error(`贵州一价区公告：未知标题或日期不符：${title}`);
    }
    entries.push({
      title,
      publishedDate,
      url: officialUrl(anchor[2], LIST_URL,
        /^\/fggz\/tzgg\/\d{6}\/t\d{8}_\d+\.html$/, '公告'),
    });
  }
  if (!entries.length) throw new Error('贵州一价区公告：列表中未找到成品油公告');
  entries.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  if (entries.length > 1 && entries[0].publishedDate === entries[1].publishedDate) {
    throw new Error(`贵州一价区公告：同日公告不唯一：${entries[0].publishedDate}`);
  }
  return entries[0];
}

function parseArticle(html, entry) {
  const site = html.match(/<meta\s+name="SiteName"\s+content="([^"]+)"/i);
  const title = html.match(/<meta\s+name="ArticleTitle"\s+content="([^"]+)"/i);
  const heading = html.match(/<div\s+class="ArticleTitle">\s*([^<]+)\s*<\/div>/i);
  const date = html.match(/<meta\s+name="PubDate"\s+content="(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}"/i);
  if (!site || site[1] !== '贵州省发展和改革委员会' ||
      !title || title[1] !== entry.title || !heading || heading[1] !== entry.title ||
      !date || validDate(date[1], '正文发布日期') !== entry.publishedDate) {
    throw new Error(`贵州一价区公告：官网、标题或日期与列表不符：${entry.url}`);
  }
  const body = html.match(/<font\s+id="Zoom">([\s\S]*?)<\/font>/i);
  if (!body) throw new Error(`贵州一价区公告：缺少公告正文：${entry.url}`);
  const text = body[1].replace(/<[^>]*>/g, '').replace(/[\s\u00a0\u3000]/g, '');
  const time = [...text.matchAll(/决定自(\d{4})年(\d{1,2})月(\d{1,2})日24时起/g)];
  if (time.length !== 1 || !text.includes('贵州省各价区汽油销售价格表') ||
      !text.includes('贵州省各价区柴油（国VI）销售价格表')) {
    throw new Error(`贵州一价区公告：生效时间或分价区附件缺失：${entry.url}`);
  }
  const announced = validDate(`${time[0][1]}-${time[0][2].padStart(2, '0')}-${time[0][3].padStart(2, '0')}`, '生效公告日期');
  if (announced !== entry.publishedDate) {
    throw new Error(`贵州一价区公告：生效日期与列表不符：${entry.url}`);
  }
  const images = [...body[1].matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)];
  if (images.length !== 2) throw new Error(`贵州一价区公告：汽油和柴油附件图片数量异常：${images.length}`);
  const directory = new URL('.', entry.url).pathname;
  const imagePattern = new RegExp(`^${directory}W\\d+\\.(?:png|jpg|jpeg)$`, 'i');
  const gasolineImageUrl = officialUrl(images[0][1], entry.url, imagePattern, '汽油价格图片');
  const dieselImageUrl = officialUrl(images[1][1], entry.url, imagePattern, '柴油价格图片');
  if (gasolineImageUrl === dieselImageUrl) throw new Error('贵州一价区公告：汽油与柴油图片重复');
  return {
    url: entry.url,
    publishedDate: entry.publishedDate,
    gasolineImageUrl,
    dieselImageUrl,
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'guizhou-zone1',
  name: '贵州·一价区',
  sourceName: '贵州省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText }) {
    if (typeof getText !== 'function') throw new TypeError('贵州一价区公告：getText 必须为函数');
    const entry = newestEntry(await getText(LIST_URL));
    return parseArticle(await getText(entry.url), entry);
  },
};
