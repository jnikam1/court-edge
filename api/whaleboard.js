const { polymarket } = require('../lib/whaleboard');
const { send } = require('../lib/http');
module.exports = (req, res) => send(res, 45, () => polymarket());
