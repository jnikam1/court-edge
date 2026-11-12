const { kalshi } = require('../lib/whaleboard');
const { send } = require('../lib/http');
module.exports = (req, res) => send(res, 60, () => kalshi());
