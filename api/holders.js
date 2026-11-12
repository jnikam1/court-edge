const { holders } = require('../lib/whaleboard');
const { send, param } = require('../lib/http');
module.exports = (req, res) => send(res, 45, () => holders(param(req, 'cond')));
