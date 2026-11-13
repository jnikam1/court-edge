const { live, ttl } = require('../lib/feed');
const { send } = require('../lib/http');
// cached at Vercel's edge for the whole ttl so many phones share one upstream call
module.exports = (req, res) => send(res, ttl(), () => live());
