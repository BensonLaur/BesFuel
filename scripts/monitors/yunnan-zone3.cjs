"use strict";
const bulletin = require('./yunnan-kunming.cjs');

// One provincial announcement and PDF cover these zones; publication validates
// each zone's own litre-price cells independently.
module.exports = {
  ...bulletin, id: 'yunnan-zone3', name: '云南·昭通、红河、文山、大理',
  async collect(options) {
    const { title, requiresManualLiterReview, ...latest } = await bulletin.collect(options);
    return { ...latest, requiresManualPriceReview: true };
  }
};
