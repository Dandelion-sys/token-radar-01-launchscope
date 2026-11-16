// LaunchScope's radar model: from a sealed DefiLlama snapshot to a ranked board.
//
// The job is threefold. First, find the protocols that record no token and are
// not a wrapped, staked or bridged product of a token that already trades.
// Second, price each one's hypothetical launch from the snapshot's own figures,
// calibrated against the protocols whose tokens do trade. Third, write a
// concrete farm plan for every row, shaped by the protocol's category and chains.
//
// Nothing here names a protocol by hand. Every number below is computed from
// the snapshot at run time, so the same program ranks a future snapshot the
// same way, and two runs over the same bytes write the same bytes.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  implied_value_usd: number;
  multiple: number;
  comps_count: number;
  growth_factor: number;
  age_factor: number;
  on_watchlist: boolean;
  farm_steps: string[];
}

export interface CompRow {
  category: string;
  comps: number;
  median_multiple: number;
  applied_multiple: number;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  watchlist_size: number;
  live_size: number;
  early_size: number;
  global_multiple: number;
  comps: CompRow[];
  rows: BoardRow[];
}

/** A name ending in a version marker, like "Foo V2" or "Foo 2.0". */
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a product of another protocol, not a protocol of their own. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names a protocol name must not begin with. */
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** The snapshot's ten fields, checked so a malformed file fails loudly. */
const FIELDS = ['slug', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'mcap_usd', 'listed_at', 'gecko_id', 'symbol'];

export function parseSnapshot(text: string): Snapshot {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('snapshot: not an object');
  const snap = raw as Record<string, unknown>;
  if (typeof snap.as_of !== 'string' || !Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist)) {
    throw new Error('snapshot: missing as_of, protocols or watchlist');
  }
  for (const p of snap.protocols as Record<string, unknown>[]) {
    for (const f of FIELDS) {
      if (!(f in p)) throw new Error(`snapshot: protocol ${String(p.slug ?? '?')} lacks ${f}`);
    }
  }
  return snap as unknown as Snapshot;
}

/** DefiLlama records no token for the protocol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** A wrapped, staked or bridged product of a token that already trades. */
export function looksLikeProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (VERSION_TAIL.test(p.name)) return true;
  const words = ` ${p.name.toLowerCase()} `;
  if (words.includes(' wrapped ') || words.includes(' staked ') || words.includes(' staking ')) return true;
  return EXCHANGES.some((e) => p.name.startsWith(e));
}

/** A protocol still waiting on a launch of its own, as far as the record shows. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return recordsNoToken(p) && !looksLikeProduct(p);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Whole years between two YYYY-MM-DD dates, never negative. */
function yearsBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return (b - a) / (365.25 * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// The value model.
//
// A token's market cap is what the market pays for a protocol's scale. For
// every category, the live protocols that already trade give a median
// market-cap-to-TVL multiple; a pre-token protocol's implied value is its TVL
// times its category's multiple. A category with few live comps is shrunk
// toward the global median (five phantom observations at the global value),
// and every multiple is winsorised at 2.5x so one frothy category cannot
// mint a trillion-dollar launch. Two snapshot facts then adjust the price:
// the 7-day TVL change, clamped to -50%..+100% and worth at most +/-25%, and
// the time the protocol has run with no token, worth up to +20% at four
// years, because a launch candidate that has survived that long is a more
// mature one. The formula, the comps and every factor ride along in the
// board so a reader can check the working on any row.

const SHRINK = 5;
const MULTIPLE_CAP = 2.5;
const MAX_AGE_BONUS_YEARS = 4;

export function buildRadar(snapshot: Snapshot): Radar {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalMultiple = median(ratios);

  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [p.mcap_usd! / p.tvl_usd]);
    else list.push(p.mcap_usd! / p.tvl_usd);
  }

  const comps: CompRow[] = [...byCategory.entries()]
    .map(([category, values]) => {
      const med = median(values);
      const applied = Math.min(MULTIPLE_CAP, (values.length * med + SHRINK * globalMultiple) / (values.length + SHRINK));
      return { category, comps: values.length, median_multiple: med, applied_multiple: applied };
    })
    .sort((a, b) => b.comps - a.comps || a.category.localeCompare(b.category));

  const multipleFor = (category: string | null): { multiple: number; count: number } => {
    if (category === null) return { multiple: globalMultiple, count: 0 };
    const row = comps.find((c) => c.category === category);
    if (row === undefined) return { multiple: globalMultiple, count: 0 };
    return { multiple: row.applied_multiple, count: row.comps };
  };

  const watchlist = new Set(snapshot.watchlist);
  const scored: BoardRow[] = [];
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    const { multiple, count } = multipleFor(p.category);
    const growth = p.change_7d === null ? 1 : 1 + clamp(p.change_7d, -50, 100) / 400;
    const age = p.listed_at === null ? 1 : 1 + 0.05 * Math.min(yearsBetween(p.listed_at, snapshot.as_of), MAX_AGE_BONUS_YEARS);
    const implied = Math.max(1, Math.floor(p.tvl_usd * multiple * growth * age));
    scored.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      category: p.category ?? 'Uncategorised',
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      implied_value_usd: implied,
      multiple,
      comps_count: count,
      growth_factor: growth,
      age_factor: age,
      on_watchlist: watchlist.has(p.slug),
      farm_steps: farmStepsFor(p),
    });
  }

  // Rank by implied value; TVL then slug break ties so the order is stable.
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug));
  scored.forEach((row, i) => {
    row.rank = i + 1;
  });

  return {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    watchlist_size: snapshot.watchlist.length,
    live_size: live.length,
    early_size: scored.length - snapshot.watchlist.length,
    global_multiple: globalMultiple,
    comps,
    rows: scored,
  };
}

// ---------------------------------------------------------------------------
// Farm plans.
//
// Each plan is written for the protocol's category and its chains: the steps
// name what to do, how much to put in and how long to stay. Amounts are
// small on purpose, a farm that only whales can run is no farm at all.

type Fill = (name: string, chain: string, chain2: string, category: string) => string;

function plan(steps: string[]): Fill[] {
  return steps.map((s) => (name: string, chain: string, chain2: string, category: string) =>
    s.replaceAll('{n}', name).replaceAll('{c2}', chain2).replaceAll('{c}', chain).replaceAll('{k}', category));
}

const GENERIC = plan([
  'Open {n} on {c} with a fresh wallet you use only for farming, fund it with enough {c} gas plus the assets you plan to use, and bookmark the official app.',
  'Make your first real transaction on {n} of at least $50, a deposit, swap or stake, and keep a note of the date and size, because airdrops usually reward real usage, not empty wallets.',
  'Return at least once a week and repeat the core action, varying the size and the day, so your activity reads as a genuine user rather than a one-off bot.',
  'Use a second feature of {n} beyond the first one, such as a different pool, vault or market, since multi-feature users are usually weighted more.',
  'Watch {n} official announcements for a points program, quests or a token hint, and join any program the day it opens rather than weeks later.',
  'Never send funds to an address from a DM or a lookalike site: open {n} only from its official app link and check the contract address before approving.',
]);

const PLANS: Record<string, Fill[]> = {
  Dexs: plan([
    'Swap at least $100 of volume on {n} on {c}, splitting it across two different trading pairs so your history shows more than a single trade.',
    'Add liquidity to one {n} pool on {c} with $100 or more and hold the position for at least two weeks, collecting the trading fees it earns.',
    'Route a second swap through {n} a week later on a different day, keeping a steady weekly rhythm instead of farming everything in one afternoon.',
    'If {n} runs a points or volume campaign, opt in before trading so every swap counts, and check your points balance after each session.',
    'Try a limit order or a second {n} feature such as concentrated liquidity, since protocols usually reward users who touch more than the basic swap.',
    'Keep $20 of {c} gas in your wallet at all times so a position never gets stuck when you need to exit, and record each trade date and size.',
  ]),
  Lending: plan([
    'Supply at least $100 of collateral to {n} on {c} and leave it earning for a minimum of two weeks rather than depositing and withdrawing the same day.',
    'Borrow a small amount against that collateral, between 20 and 40 percent of its value, and repay it in full within a week to show a complete borrow cycle.',
    'Supply a second asset to {n} on {c} so your account holds more than one market, which most lending rewards weight more than a single deposit.',
    'Repeat the supply and borrow cycle once a month, keeping your health factor above 2 at all times so a price dip never liquidates you.',
    'If {n} lists a points program, join it first and confirm your supply is earning points before adding more funds.',
    'Set a weekly reminder to check your {n} position: top up collateral if your health factor falls, and never borrow more than you can repay.',
  ]),
  'Risk Curators': plan([
    'Deposit at least $100 into a {n} curator vault on {c} and hold the position for at least a month, since curators reward patient capital, not flash deposits.',
    'Compare two or three {n} vaults by their underlying markets and pick the one whose risk profile you understand, rather than chasing the highest headline yield.',
    'Add a second deposit to the same {n} vault two weeks later, building a history of repeated allocations instead of a single lump sum.',
    'Read the vault curator page and note who manages it: a vault run by a known team with a public track record is the safer farm.',
    'Track your vault shares weekly and keep the position through at least one full interest cycle so your deposit earns a full period of yield.',
    'If {n} opens a points or early-user program, register the same wallet you deposited with, so the vault activity links to your registration.',
  ]),
  'Onchain Capital Allocator': plan([
    'Allocate at least $100 through {n} on {c} into one of its managed strategies and keep the capital deployed for at least a month.',
    'Read the strategy mandate before depositing so you know what assets it holds and what can move your balance, and write the entry date down.',
    'Make a second allocation to a different {n} strategy after two weeks, spreading across two strategies instead of one.',
    'Check your allocation weekly, noting the yield it reports, and rebalance only when the strategy itself recommends it.',
    'If {n} runs a points, waitlist or early-depositor program, sign up with the wallet you allocated from before adding more capital.',
    'Keep enough {c} gas for an exit at all times, and never allocate money you need within the month, since strategies can lock funds for a period.',
  ]),
  RWA: plan([
    'Buy or mint at least $100 of a tokenised real-world asset on {n} on {c} and hold it for a minimum of two weeks to register as a genuine holder.',
    'Read the asset backing documents on {n} before buying so you know what the token represents and who the issuer is.',
    'Use a second {n} product, such as a different asset or a yield vault, so your wallet shows more than one interaction with the protocol.',
    'If the asset pays yield, claim or compound it at least once so your history includes a claim transaction, not just a purchase.',
    'Repeat a small purchase monthly to build a steady holder record, and keep your purchase receipts and dates in a note.',
    'Watch {n} official channels for a points or holder-rewards program and join with the same wallet that holds the assets.',
  ]),
  Yield: plan([
    'Deposit at least $100 into a {n} yield vault on {c} and leave it compounding for at least three weeks.',
    'Claim or harvest the vault rewards at least once, since a claim transaction proves active use rather than a passive deposit.',
    'Deposit into a second {n} vault on a different asset after two weeks to broaden the strategies your wallet has used.',
    'Check the vault APY and your balance weekly, and move funds only when the yield drops sharply for more than a week.',
    'If {n} has a points program, confirm your vault deposits are earning points before you add more capital.',
    'Keep $20 of {c} gas aside so you can always exit a vault, and never deposit funds you need back within the month.',
  ]),
  Derivatives: plan([
    'Open a small position of $50 to $100 on {n} on {c}, using no more than 3x leverage, and close it within a few days.',
    'Trade on {n} at least once a week for a month, varying long and short positions and keeping each trade under 5 percent of your farming budget.',
    'Use a limit or stop-loss order on {n} at least once, since orders are a distinct feature many reward programs weight separately.',
    'Provide liquidity or margin to a {n} market if it offers it, with at least $50, to add a second kind of activity to your account.',
    'Set a strict loss limit before each trade, for example 2 percent of the position, and stop trading for the week if you hit it twice.',
    'If {n} runs a trading-points campaign, check that your volume is being counted after your first week of trades.',
  ]),
  CDP: plan([
    'Lock at least $150 of collateral in a {n} vault on {c} and mint a modest amount of its stablecoin, keeping your collateral ratio above 200 percent.',
    'Use the minted stablecoin for a real purpose, such as swapping it or supplying it elsewhere, then repay the debt in full within two weeks.',
    'Open a second {n} vault with a different collateral asset so your account shows more than one collateral type.',
    'Check your vault collateral ratio weekly and top it up whenever it drifts below 200 percent, so a market dip never liquidates you.',
    'Repeat the mint-and-repay cycle once a month, keeping each mint below half of your collateral value.',
    'If {n} has a points or early-user program, register the wallet you minted from and confirm the vault activity is tracked.',
  ]),
  'Yield Aggregator': plan([
    'Deposit at least $100 into a {n} strategy vault on {c} and hold it for at least three weeks so it completes a full compounding cycle.',
    'Harvest or claim the strategy rewards at least once, and either compound them or withdraw them, so your wallet shows an active claim.',
    'Try a second {n} strategy on a different asset after two weeks, giving your wallet two distinct strategy interactions.',
    'Compare the vault reported APY weekly and move funds only if the yield stays well below its peers for two weeks running.',
    'If {n} runs a points program, verify your deposits earn points before adding more, and use the same wallet throughout.',
    'Keep enough {c} gas to exit any vault quickly, and never deposit funds you may need within the month.',
  ]),
  'Basis Trading': plan([
    'Deposit at least $100 into a {n} basis strategy on {c} and hold the position for at least two weeks to capture a full funding cycle.',
    'Read how the strategy earns its yield, funding rates or spot-perpetual spreads, before depositing, so you understand what can move it.',
    'Add a second deposit two weeks later rather than all at once, building a record of repeated allocations.',
    'Check the strategy yield and your balance weekly, and note any week the yield turns negative so you can decide whether to stay.',
    'If {n} offers a points or early-user program, join it with the depositing wallet and confirm your balance is counted.',
    'Keep {c} gas ready for an exit and never allocate money you need soon, since basis positions can take days to unwind.',
  ]),
  Chain: plan([
    'Bridge at least $50 to {n} and make your first transaction there within a day of arriving, so your wallet is an early active user of the chain.',
    'Use at least three different apps on {n} in your first month, such as a swap, a lending market and a yield vault, spreading $30 or more across them.',
    'Return weekly to transact on {n}, varying the apps you use, so your history shows sustained activity rather than a single visit.',
    'Hold a small balance of the chain native gas token so you can always transact, and keep a note of every app you used and when.',
    'If {n} or its apps run quests, points or a testnet-to-mainnet program, join early with the same wallet you already use on the chain.',
    'Follow {n} official announcements for a token or airdrop hint, and beware of fake airdrop sites: only use links from the chain official pages.',
  ]),
  'Staking Pool': plan([
    'Stake at least $100 through {n} on {c} and keep it staked for at least a month, since staking rewards reward time in the pool.',
    'Claim or restake your staking rewards at least once so your wallet shows an active claim, not just a deposit.',
    'Stake a second asset or into a second {n} pool after two weeks to show more than one staking interaction.',
    'Check your staked balance and the pool yield weekly, and note the unbonding period so you know how long an exit takes.',
    'If {n} runs a points or early-staker program, register the staking wallet and confirm your stake is counted.',
    'Never stake funds you need within the unbonding period, and keep enough {c} gas to unstake when you need to.',
  ]),
  'Prediction Market': plan([
    'Place at least three bets of $10 or more on {n} on {c}, on different markets, so your account shows real trading rather than a single wager.',
    'Trade both sides of a market at least once, buying YES in one market and NO in another, to show varied participation.',
    'Return weekly for a month and place a new bet each week, keeping your total exposure under $200 while you learn the platform.',
    'Provide liquidity to a {n} market if it offers it, with at least $20, to add a second kind of activity to your account.',
    'Cash out or settle at least one winning position so your history includes a completed trade, not only open bets.',
    'If {n} runs a points or volume campaign, check that your trades are counted after your first week, and keep a note of each market you traded.',
  ]),
  'Liquidity Manager': plan([
    'Deposit at least $100 into a {n} managed liquidity position on {c} and hold it for at least two weeks to earn a full fee period.',
    'Check the position range and fees weekly, and rebalance only when the position drifts out of range, not on every price move.',
    'Add a second {n} position in a different pool after two weeks so your wallet shows more than one managed position.',
    'Collect the fees your position earns at least once, so your history includes a fee claim as well as a deposit.',
    'If {n} runs a points program, confirm your positions earn points before adding more capital.',
    'Keep {c} gas aside for rebalances and exits, and never deposit funds you need back within the month.',
  ]),
  'Leveraged Farming': plan([
    'Open a small leveraged farming position of $50 to $100 on {n} on {c}, keeping leverage at 2x or below, and monitor it daily for the first week.',
    'Check your health factor or liquidation price every day the position is open, and top up collateral if it moves within 20 percent of liquidation.',
    'Close the position after two to three weeks and record the profit or loss, so you can judge whether the strategy is worth repeating.',
    'Try a second {n} strategy with a different pair after closing the first, rather than doubling down on the same pool.',
    'If {n} runs a points program, verify your farming is counted before committing more capital.',
    'Never use leverage above 3x while farming, and never risk more than 5 percent of your farming budget on one position.',
  ]),
  Restaking: plan([
    'Restake at least $100 of liquid staking tokens through {n} on {c} and keep the position for at least a month.',
    'Claim or compound your restaking rewards at least once so your wallet shows an active claim.',
    'Restake into a second operator or vault on {n} after two weeks to diversify the operators your wallet supports.',
    'Check the restaking yield and any slashing conditions weekly, and note the withdrawal delay before you deposit.',
    'If {n} runs a points or early-user program, register the restaking wallet and confirm your position is tracked.',
    'Keep {c} gas ready for exits, and never restake funds you need within the withdrawal delay.',
  ]),
};

export function farmStepsFor(p: SnapshotProtocol): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const chain2 = p.chains[1] ?? chain;
  const category = p.category ?? 'Uncategorised';
  const fills = PLANS[category] ?? GENERIC;
  return fills.map((f) => f(p.name, chain, chain2, category));
}

// ---------------------------------------------------------------------------
// The gate's shape, checked before anything is written.

export function boardIssue(radar: Radar, snapshot: Snapshot): string | null {
  const rows = radar.rows;
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, outside 100 to 4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const row of rows) {
    if (!slugs.has(row.slug)) return `row ${row.slug} is not a snapshot protocol`;
    if (seen.has(row.slug)) return `row ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.name.trim() === '') return `row ${row.slug} has no name`;
    if (!Number.isInteger(row.rank) || row.rank < 1) return `row ${row.slug} has a bad rank`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > 100_000_000_000_000) {
      return `row ${row.slug} has a bad implied value`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug} has a farm step of ${len} characters`;
    }
  }
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  if (ranks.some((r, i) => r !== i + 1)) return 'ranks are not exactly 1 to N';
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return 'implied value rises with rank';
  }
  if (new Set(rows.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data as a script the page loads: one global, no network. */
export function dataScript(radar: Radar): string {
  const payload = {
    meta: {
      as_of: radar.as_of,
      floor_usd: radar.floor_usd,
      watchlist_size: radar.watchlist_size,
      live_size: radar.live_size,
      early_size: radar.early_size,
      global_multiple: radar.global_multiple,
      comps: radar.comps,
    },
    rows: radar.rows,
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}
