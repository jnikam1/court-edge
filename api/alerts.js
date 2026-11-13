const { board } = require('../lib/alerts');
const { send } = require('../lib/http');
module.exports = (req, res) => send(res, 45, () => board());
