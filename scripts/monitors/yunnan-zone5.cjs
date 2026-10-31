"use strict";
const bulletin = require('./yunnan-kunming.cjs');

// One provincial announcement and PDF cover these zones; publication validates
// each zone's own litre-price cells independently.
module.exports = {
  ...bulletin, id: 'yunnan-zone5', name: '云南第五价区',
  async collect(options) {
    const { title, requiresManualLiterReview, ...latest } = await bulletin.collect(options);
    return { ...latest, requiresManualPriceReview: true };
  }
};
