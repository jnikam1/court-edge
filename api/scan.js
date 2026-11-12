const { scan } = require('../lib/scan');
const { send } = require('../lib/http');
module.exports = (req, res) => send(res, 6, () => scan());
