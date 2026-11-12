# Court Edge

Phone page for Kalshi tennis. Lists every open ATP, WTA and ATP Challenger match. Tap one for
the live score, a fair value from the score, the price path, taker money flow on Kalshi,
Polymarket wallets split by lifetime profit, recent form and ratings.

## Deploy

    npx vercel --prod

Run it inside this folder. No build step and no dependencies.

## Optional: Claude write-up

In the Vercel project, Settings > Environment Variables, add `ANTHROPIC_API_KEY`. The
"Write analysis" button then calls Claude once per tap. `ANTHROPIC_MODEL` overrides the model.
Never put the key in the code or the page.

## Where the data comes from

- Prices, trades, set markets, recent results: Kalshi public API, no key.
- Live game score and wallet positions: Polymarket public APIs, no key.
- Ratings and serve numbers: `lib/players.json`, built from tour results to June 2026.
- Set-break fair values: `lib/rules.json`, fitted on settled Kalshi matches.
