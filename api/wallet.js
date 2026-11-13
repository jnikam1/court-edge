const { wallet, holders } = require('../lib/whaleboard');
const { send, param } = require('../lib/http');
// ?w=<wallet>[&cond=<market>] for one wallet, or ?cond=<market> alone for who holds that market
module.exports = (req, res) => send(res, 30, () => { const w = param(req, 'w'); const cond = param(req, 'cond'); return w ? wallet(w, cond) : holders(cond); });
