// TEMPORARY probe while the NBA and NFL data shapes are being checked. Replaced before release.
function shape(x, depth, n) {
  if (x === null || typeof x !== 'object') return typeof x === 'string' && x.length > 70 ? x.slice(0, 70) + '…' : x;
  if (depth <= 0) return Array.isArray(x) ? '[' + x.length + ']' : '{' + Object.keys(x).slice(0, 12).join(',') + '}';
  if (Array.isArray(x)) return { _len: x.length, _first: x.slice(0, n).map((y) => shape(y, depth - 1, n)) };
  const o = {}; for (const k of Object.keys(x).slice(0, 40)) o[k] = shape(x[k], depth - 1, n); return o;
}
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    const u = new URL(q.get('u'));
    if (!/(^|\.)espn\.com$/.test(u.hostname)) throw new Error('host');
    const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; court-edge/1.0)' } });
    let d = await r.json();
    for (const k of (q.get('path') || '').split('.').filter(Boolean)) d = d == null ? d : d[k];
    res.statusCode = 200; res.end(JSON.stringify({ http: r.status, d: shape(d, Number(q.get('depth') || 4), Number(q.get('n') || 2)) }).slice(0, 9000));
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message || e) })); }
};
