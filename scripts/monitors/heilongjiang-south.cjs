'use strict';

const HOSTNAME = 'drc.hlj.gov.cn';
const LIST_URL = 'https://drc.hlj.gov.cn/common/search/b7cc7a3d659240c7a92b07e66eff9824?_isAgg=true&_isJson=true&_pageSize=30&_template=index&_rangeTimeGte=&_channelName=&page=1';
const ARTICLE_PATH = /^\/drc\/c111486\/\d{6}\/c00_(\d+)\.shtml$/;
const VERIFIED_COEFFICIENT_START = '2026-05-01';
const VERIFIED_COEFFICIENT_END = '2026-10-31';
const COEFFICIENT_NOTICE_URL = 'https://drc.hlj.gov.cn/drc/c111433/202604/c00_31936584.shtml';

function chinaDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`黑龙江南区油价：${label}无效：${value}`);
  }
  return value;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function officialUrl(reference, base, pattern, label) {
  const url = new URL(reference, base);
  if (url.protocol !== 'https:' || url.hostname !== HOSTNAME || url.username || url.password ||
      url.search || url.hash || !pattern.test(url.pathname)) {
    throw new Error(`黑龙江南区油价：${label}不是预期的省发改委地址：${url.href}`);
  }
  return url.href;
}

function compactText(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:ensp|nbsp|thinsp);|&#(?:160|8194|8201);/gi, '')
    .replace(/\s|\u3000/g, '');
}

function latestEntry(json) {
  let response;
  try { response = JSON.parse(json); } catch (_) { throw new Error('黑龙江南区油价：官方列表不是 JSON'); }
  const entries = response?.data?.results;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 30) {
    throw new Error('黑龙江南区油价：官方列表结果异常');
  }
  let previous = null;
  const priceEntries = [];
  for (const entry of entries) {
    const day = validDate(entry.publishedTimeStr?.slice(0, 10), '列表发布日期');
    if (previous && day > previous) throw new Error('黑龙江南区油价：官方列表日期顺序异常');
    previous = day;
    if (!entry.title?.includes('成品油价格')) continue;
    if (!/^我省(?:调整|上调|下调)成品油价格$/.test(entry.title)) {
      throw new Error(`黑龙江南区油价：未知公告标题：${entry.title}`);
    }
    priceEntries.push({
      title: entry.title,
      publishedDate: day,
      url: officialUrl(entry.url, 'https://drc.hlj.gov.cn', ARTICLE_PATH, '公告'),
    });
  }
  if (!priceEntries.length) throw new Error('黑龙江南区油价：官方列表中未找到调价公告');
  if (priceEntries.length > 1 && priceEntries[0].publishedDate === priceEntries[1].publishedDate) {
    throw new Error(`黑龙江南区油价：同日调价公告不唯一：${priceEntries[0].publishedDate}`);
  }
  return priceEntries[0];
}

function parseArticle(html, entry) {
  const title = html.match(/<h1\s+class="article_title">\s*([^<]+)\s*<\/h1>/);
  if (!title || title[1].trim() !== entry.title) {
    throw new Error(`黑龙江南区油价：公告标题与列表不符：${entry.url}`);
  }
  const date = html.match(/<span\s+class="date">日期：<b>(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}<\/b><\/span>/);
  if (!date || validDate(date[1], '正文发布日期') !== entry.publishedDate) {
    throw new Error(`黑龙江南区油价：发布日期与列表不符：${entry.url}`);
  }
  const start = html.indexOf('class="article_content" id="zoomcon"');
  const end = html.indexOf('<!--正文 end-->', start);
  if (start < 0 || end < 0) throw new Error(`黑龙江南区油价：缺少公告正文：${entry.url}`);
  const body = html.slice(start, end);
  const text = compactText(body);
  const effective = text.match(/自(\d{4})年(\d{1,2})月(\d{1,2})日24时起/);
  if (!effective) throw new Error(`黑龙江南区油价：缺少明确的24时生效时间：${entry.url}`);
  const announcedDay = validDate(`${effective[1]}-${effective[2].padStart(2, '0')}-${effective[3].padStart(2, '0')}`, '生效公告日期');
  if (announcedDay !== entry.publishedDate) {
    throw new Error(`黑龙江南区油价：生效公告日期与发布日期不符：${entry.url}`);
  }
  const benchmark = text.match(/89号汽油最高零售价格为每吨(\d+)元[，,]0号柴油最高零售价格为每吨(\d+)元/);
  if (!benchmark || Number(benchmark[1]) < 1000 || Number(benchmark[2]) < 1000) {
    throw new Error(`黑龙江南区油价：正文吨价基准缺失：${entry.url}`);
  }
  const articleId = new URL(entry.url).pathname.match(ARTICLE_PATH)?.[1];
  const images = [...body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)];
  if (images.length !== 1) throw new Error(`黑龙江南区油价：价格表图片数量异常：${images.length}`);
  const imageUrl = officialUrl(images[0][1], entry.url,
    new RegExp(`^/drc/c111486/\\d{6}/${articleId}/images/[^/]+\\.(?:png|jpg|jpeg)$`, 'i'), '价格表图片');
  // 各标号吨价在图片中，且南北区每年两次更换折算系数；不能由正文基准吨价推算升价。
  return {
    url: entry.url,
    publishedDate: entry.publishedDate,
    effectiveDate: nextDate(announcedDay),
    imageUrl,
    requiresManualPriceReview: true,
  };
}

module.exports = {
  id: 'heilongjiang-south',
  name: '黑龙江南区',
  sourceName: '黑龙江省发展和改革委员会',
  allowedHostnames: [HOSTNAME],
  async collect({ getText, today = chinaDate() }) {
    if (typeof getText !== 'function') throw new TypeError('黑龙江南区油价：getText 必须为函数');
    const todayDate = validDate(today, '今天');
    const entry = latestEntry(await getText(LIST_URL));
    const notice = parseArticle(await getText(entry.url), entry);
    // 换季会单独改变元/升最高限价，未必伴随新调价公告，需独立报告复核状态。
    return {
      ...notice,
      coefficientNoticeUrl: COEFFICIENT_NOTICE_URL,
      coefficientValidFrom: VERIFIED_COEFFICIENT_START,
      coefficientValidThrough: VERIFIED_COEFFICIENT_END,
      requiresManualCoefficientReview: todayDate < VERIFIED_COEFFICIENT_START ||
        todayDate > VERIFIED_COEFFICIENT_END,
    };
  },
};
