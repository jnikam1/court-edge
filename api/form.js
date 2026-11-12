const { form } = require('../lib/detail');
const { send, param } = require('../lib/http');
module.exports = (req, res) => send(res, 300, () => form(param(req, 'event')));
