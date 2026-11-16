# token-radar-01-launchscope

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Dandelion-sys/token-radar-01-launchscope/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Dandelion-sys/token-radar-01-launchscope/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

LaunchScope is a token launch radar: it reads a frozen DefiLlama snapshot, finds the protocols that record no token and are not a wrapped, staked or bridged product of a token that already trades, prices each one's hypothetical launch from its TVL times its category's market-cap-to-TVL multiple among the protocols whose tokens do trade (adjusted for 7-day growth and time untokenised), and hands in a static dashboard with the ranked board, a detail view showing the valuation working and a concrete farm plan for every protocol, plus search, category, chain and watchlist filters.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22 or later, standard library only, no network. The program writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory, deterministically: two runs over the same snapshot write the same bytes.
