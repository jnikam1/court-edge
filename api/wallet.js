const { wallet } = require('../lib/whaleboard');
const { send, param } = require('../lib/http');
module.exports = (req, res) => send(res, 30, () => wallet(param(req, 'w'), param(req, 'cond')));
