// Optional: a written analysis from Claude. Needs ANTHROPIC_API_KEY set in the Vercel project.
const { detail, form, whales } = require('../lib/detail');
const { send, param } = require('../lib/http');
const { cached } = require('../lib/kalshi');

const SYSTEM = [
  'You are a blunt tennis in-play trading analyst for a Kalshi trader. You get JSON for one match: Kalshi prices, live score, a fair value from a point-level model, money flow, the biggest Polymarket wallets in the match graded on their recent tennis record, recent form and ratings.',
  'Write for a phone. Verdict first in one line: Bet, Small bet, or Pass, with side and a price limit. Then at most five short bullets of reasons, then one line on what would change your mind.',
  'Rules you must respect: a backtest of about 2,300 settled Kalshi matches found the price right after set 1 fair on average for both tours, so no signal here is a proven edge and stakes should stay small. Ratings stop at model.through, so pre-match rating gaps are weak. Without live serve stats, an in-play model gap under 5 cents is a small bet at most. Whale money and taker flow are not proven to predict winners: say what they show, do not treat them as edge. A favourite who drops set 1 wins less than a frozen pre-match model says. Up a break early in a deciding set tends to be overpriced.',
  'Never invent numbers. If data is missing, say so. Plain English, no hype, no dashes as punctuation.',
].join(' ');

module.exports = (req, res) => send(res, 45, async () => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { off: true };
  const event = param(req, 'event');
  if (!event) return { error: 'No match given.' };
  return cached('ai-' + event, 45000, async () => {
    const [d, f, w] = await Promise.all([detail(event, null), form(event).catch(() => null), whales(event).catch(() => null)]);
    if (d.error) return d;
    delete d.chart;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 500, system: SYSTEM,
        messages: [{ role: 'user', content: 'Player a is ' + d.a.name + ', player b is ' + d.b.name + '. Prices are probabilities of a winning unless a field says otherwise.\n' + JSON.stringify({ match: d, form: f, whales: w }) }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return { error: 'Claude API ' + r.status + ': ' + ((j.error && j.error.message) || 'failed') };
    return { asOf: new Date().toISOString(), text: (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
  });
});
