'use strict';

const province = require('./heilongjiang-south.cjs');

const COEFFICIENT_NOTICE_URL = 'https://drc.hlj.gov.cn/drc/c111433/202604/c00_31936584.shtml';
const COEFFICIENT_RULE_URL = 'https://drc.hlj.gov.cn/drc/c111444/201701/c00_31467233.shtml';
const COEFFICIENT_VALID_FROM = '2026-05-01';
const COEFFICIENT_VALID_THROUGH = '2026-10-31';

function chinaDate() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

module.exports = {
  id: 'heilongjiang-north',
  name: '黑龙江北区',
  sourceName: '黑龙江省发展和改革委员会',
  allowedHostnames: province.allowedHostnames,
  async collect({ getText, today } = {}) {
    // 两价区共用同一份省级吨价公告，吨升系数及适用地区分别核价。
    const notice = await province.collect({ getText, today });
    const asOf = today || chinaDate();
    return {
      ...notice,
      coefficientNoticeUrl: COEFFICIENT_NOTICE_URL,
      coefficientRuleUrl: COEFFICIENT_RULE_URL,
      coefficientValidFrom: COEFFICIENT_VALID_FROM,
      coefficientValidThrough: COEFFICIENT_VALID_THROUGH,
      // 每年 11 月和 5 月换季，即使最新调价公告没有变化也需要复核元/升价。
      requiresManualCoefficientReview: asOf < COEFFICIENT_VALID_FROM ||
        asOf > COEFFICIENT_VALID_THROUGH,
    };
  },
};
