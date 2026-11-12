const { detail } = require('../lib/detail');
const { send, param } = require('../lib/http');
module.exports = (req, res) => send(res, 5, () => {
  const srv = param(req, 'srv');
  return detail(param(req, 'event'), srv === 'a' || srv === 'b' ? srv : null);
});
