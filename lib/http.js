function param(req, name) {
  try { const v = new URL(req.url, 'http://x').searchParams.get(name); return v && /^[A-Za-z0-9_.-]{1,80}$/.test(v) ? v : null; } catch (e) { return null; }
}
async function send(res, maxAge, fn) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const body = JSON.stringify(await fn());
    res.setHeader('Cache-Control', 'public, s-maxage=' + maxAge + ', stale-while-revalidate=' + maxAge * 3);
    res.statusCode = 200; res.end(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 502; res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }
}
module.exports = { param, send };
