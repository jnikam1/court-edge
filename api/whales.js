const { whales } = require('../lib/detail');
const { send, param } = require('../lib/http');
module.exports = (req, res) => send(res, 90, () => whales(param(req, 'event')));
