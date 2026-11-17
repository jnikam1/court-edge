# Court Edge

Phone page for Kalshi tennis. Lists every open ATP, WTA and ATP Challenger match. Tap one for
the live score, a fair value from the score, the price path, taker money flow on Kalshi,
Polymarket wallets split by lifetime profit, recent form and ratings.

## Whales tab

Tracks 43 top Polymarket wallets graded per category on their full betting history, shows what
they hold right now, and lists profitable Kalshi profiles that show their positions. The
grades live in `lib/whales.json` and `lib/kalshi_profiles.json` and are rebuilt offline.

## Deploy

Connected to Vercel through GitHub. Every push to `main` redeploys. No build step and no
dependencies.

## Optional: Claude write-up

In the Vercel project, Settings > Environment Variables, add `ANTHROPIC_API_KEY`. The
"Write analysis" button then calls Claude once per tap. `ANTHROPIC_MODEL` overrides the model.
Never put the key in the code or the page.

## Where the data comes from

- Prices, trades, set markets, recent results: Kalshi public API, no key.
- Live game score and wallet positions: Polymarket public APIs, no key.
- Ratings and serve numbers: `lib/players.json`, built from tour results to June 2026.
- Set-break fair values: `lib/rules.json`, fitted on settled Kalshi matches.

## Layout of the front end
- `index.html` is markup only. Styles are in `assets/app.css`, behaviour in `assets/app.js`. No build step.
- Four main screens: Discover (All, Tennis, NBA, NFL), Watchlist, Positions, Alerts. The whale tracker is linked from the sidebar on desktop and from Discover on a phone.
- Watchlist, positions and price alerts are stored on the device (`localStorage`). Positions are entered by hand; nothing is read from or sent to a Kalshi or Polymarket account.
- Price alerts are pushed by the logger (`worker/`) only when phone alerts are on. Otherwise they are checked while the app is open, and the app says so.

## Run and check locally
- `node scripts/dev.js` serves the page and the `api/` handlers on http://localhost:4173.
- `npm test` runs the checks in `scripts/checks.js`.

## The decision engine
`worker/src/brain.js` holds the trading setups as pure functions. Once a minute the logger runs them on every live game and match, opens a paper trade when one fires, manages it (target, deadline, cancel, settlement) and scores it. The record is at `/signals` on the logger and under Trade setups in the Alerts tab.
- `nfl_dog_lead`: a game priced close before kick-off where the underdog's price crosses 62¢. Sell at 80¢. Backed by 137 past games.
- `nba_recovery`, `score_follow`, `tennis_reprice`: new, no record yet. They exist so the record can say whether they work.
- Whale alerts carry a `maker` read (`lib/alerts.js` `makerRead`): `maker` when the wallet merged pairs or bought both sides of two or more markets in the window, `thin` when its lifetime profit is under 1% of $20M+ traded, `losing` when that figure is negative. Flagged wallets show on the Alerts tab with the reason and are never sent to the phone. Cards also list the wallet's other open markets on the same game (`net.also`), the sportsbook line without its margin and Kalshi's ask for NBA and NFL game winners (`ref`, pre-game line only), and the wallet's tracked markouts from `/brief` (`whales`: 5 and 15 minute moves, an hour net of fees, and a size-weighted count `effN`). `/brief` `whaleSplit` scores the label itself: one-hour results for flagged and unflagged wallets side by side.
- `injury_news`, `whale_add`: not trades to copy. They measure how the price moves after late injury news and after a big whale add, and grade each whale by sport.

## UFC
`lib/ufc.js` lists Kalshi's fight markets (`KXUFCFIGHT`) and, on a fight's page, its method, rounds and distance markets. Served through `/api/sports?league=ufc`.
There is no live round feed yet, and Kalshi's time on a bout is its expected result time, not the walkout, so the app does not claim a fight is under way.
The engine's `ufc_fav` setup buys every favourite on paper when the bout before it ends and holds to the result. It is record keeping, not a tip: it builds our own table of how often favourites win at each price, and what rolling the two biggest favourites of a card returns.
