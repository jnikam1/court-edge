const { detail } = require('../lib/detail');
const { send, param } = require('../lib/http');
// ?event=<Kalshi event>&srv=a|b (who is serving)&pts=40-15 (point score, first player first)
module.exports = (req, res) => send(res, 5, () => {
  const srv = param(req, 'srv'); const pts = param(req, 'pts');
  return detail(param(req, 'event'), srv === 'a' || srv === 'b' ? srv : null, pts && /^(\d{1,2}|A|AD)-(\d{1,2}|A|AD)$/i.test(pts) ? pts.split('-') : null);
});
