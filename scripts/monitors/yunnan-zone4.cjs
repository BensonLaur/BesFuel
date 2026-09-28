'use strict';

const bulletin = require('./yunnan-kunming.cjs');

// The provincial notice and PDF cover all five price zones; only the reviewed
// liter-price snapshot differs for 普洱、保山、丽江.
module.exports = {
  ...bulletin,
  id: 'yunnan-zone4',
  name: '云南·普洱/保山/丽江',
};
