const S = require('../lib/sports');
const { send, param } = require('../lib/http');
// ?league=nba|nfl lists games. Add &event=<Kalshi event> for one game. ?view=watch is the compact feed the logger reads.
module.exports = (req, res) => {
  const event = param(req, 'event'); const league = param(req, 'league');
  if (param(req, 'view') === 'watch') return send(res, 20, () => S.watch());
  if (event) return send(res, 5, () => S.detail(league, event));
  return send(res, 6, () => S.board(league));
};
