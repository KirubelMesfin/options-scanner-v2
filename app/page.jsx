import LivePricePanel from './components/LivePricePanel';
const API_BASE = 'https://api.polygon.io';
const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

export const dynamic = 'force-dynamic';

class PolygonAccessError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'PolygonAccessError';
    this.status = status;
    this.details = details;
  }
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatCurrency(value) {
  return value == null ? 'N/A' : `$${value.toFixed(2)}`;
}

function formatCompactNumber(value) {
  if (value == null) return 'N/A';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value) {
  return value == null ? 'N/A' : `${value.toFixed(2)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function highest(values) {
  if (!values.length) return null;
  return Math.max(...values);
}

function lowest(values) {
  if (!values.length) return null;
  return Math.min(...values);
}

function getDaysToExpiration(expirationDate) {
  if (!expirationDate) return null;
  const now = new Date();
  const exp = new Date(`${expirationDate}T00:00:00Z`);
  return Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
}

function classifyTrend({ price, ma20, ma50, slope20 }) {
  if (price == null || ma20 == null || ma50 == null || slope20 == null) return 'neutral';
  if (price > ma20 && ma20 > ma50 && slope20 > 0) return 'bullish';
  if (price < ma20 && ma20 < ma50 && slope20 < 0) return 'bearish';
  return 'neutral';
}

function classifySetup({ trend, price, high5, high20, low20, ma20, ma50, atr }) {
  if ([trend, price, high5, high20, low20, ma20, ma50, atr].some((v) => v == null)) return 'weak trend';

  const breakoutThreshold = high20 - atr * 0.15;
  const pullbackZoneLower = ma20 - atr * 0.6;
  const pullbackZoneUpper = ma20 + atr * 0.3;

  if (trend === 'bullish' && price >= breakoutThreshold && price >= high5 - atr * 0.15) return 'breakout';
  if (trend === 'bullish' && price >= pullbackZoneLower && price <= pullbackZoneUpper && price > ma50 && price > low20) return 'pullback';

  const rangeHeight = high20 - low20;
  if (rangeHeight > 0 && Math.abs(price - (high20 + low20) / 2) <= rangeHeight * 0.25) return 'range';

  return 'weak trend';
}

function estimateEntryPlan({ price, setup, high20, low20, ma20, ma50, atr }) {
  if (price == null || atr == null) {
    return {
      entryQuality: 'Low',
      buyZone: 'N/A',
      invalidation: 'N/A',
      target: 'N/A'
    };
  }

  if (setup === 'breakout') {
    const buyLow = Math.max(price - atr * 0.3, 0);
    const buyHigh = price + atr * 0.2;
    const invalidation = ma20 ?? price - atr;
    const target = high20 != null ? high20 + atr * 1.5 : price + atr * 2;
    return {
      entryQuality: 'High',
      buyZone: `${formatCurrency(buyLow)} - ${formatCurrency(buyHigh)}`,
      invalidation: formatCurrency(invalidation),
      target: formatCurrency(target)
    };
  }

  if (setup === 'pullback') {
    const support = ma20 ?? ma50 ?? price;
    const buyLow = Math.max(support - atr * 0.35, 0);
    const buyHigh = support + atr * 0.25;
    const invalidation = Math.min(low20 ?? support - atr, support - atr * 0.8);
    const target = high20 != null ? high20 + atr * 0.8 : price + atr * 1.5;
    return {
      entryQuality: 'Good',
      buyZone: `${formatCurrency(buyLow)} - ${formatCurrency(buyHigh)}`,
      invalidation: formatCurrency(invalidation),
      target: formatCurrency(target)
    };
  }

  if (setup === 'range') {
    const zone = `${formatCurrency(Math.max((low20 ?? price) + atr * 0.2, 0))} - ${formatCurrency((high20 ?? price) - atr * 0.2)}`;
    return {
      entryQuality: 'Mixed',
      buyZone: zone,
      invalidation: formatCurrency((low20 ?? price) - atr * 0.6),
      target: formatCurrency(high20 ?? price + atr)
    };
  }

  return {
    entryQuality: 'Low',
    buyZone: `${formatCurrency(price - atr * 0.2)} - ${formatCurrency(price + atr * 0.2)}`,
    invalidation: formatCurrency((ma50 ?? low20 ?? price) - atr * 0.5),
    target: formatCurrency(price + atr)
  };
}

function probabilityBand(score) {
  if (score >= 82) return '80-90%';
  if (score >= 65) return '65-79%';
  if (score >= 50) return '50-64%';
  return 'Below 50%';
}

function scoreChartQuality(analysis) {
  const { trend, setup, price, ma20, ma50, rsi, atr } = analysis;
  if ([price, ma20, ma50, rsi, atr].some((v) => v == null)) return 35;

  let score = 35;
  if (trend === 'bullish') score += 20;
  if (setup === 'breakout') score += 20;
  else if (setup === 'pullback') score += 15;
  else if (setup === 'range') score += 6;

  if (price > ma20) score += 6;
  if (price > ma50) score += 6;

  if (rsi >= 48 && rsi <= 68) score += 8;
  else if (rsi > 75) score -= 8;

  return clamp(score, 5, 95);
}

function normalizeContract(raw) {
  const bid = toNumber(raw?.last_quote?.bid);
  const ask = toNumber(raw?.last_quote?.ask);
  const strike = toNumber(raw?.details?.strike_price);

  return {
    ticker: raw?.details?.ticker ?? 'N/A',
    contractType: raw?.details?.contract_type ?? 'N/A',
    strike,
    expiration: raw?.details?.expiration_date ?? null,
    bid,
    ask,
    lastPrice: toNumber(raw?.last_trade?.price ?? raw?.day?.close),
    volume: toNumber(raw?.day?.volume),
    openInterest: toNumber(raw?.open_interest),
    impliedVolatility: toNumber(raw?.implied_volatility),
    delta: toNumber(raw?.greeks?.delta),
    midpoint: bid != null && ask != null ? (bid + ask) / 2 : null
  };
}

function scoreContractQuality(contract, stockPrice, targetDte) {
  const volume = contract.volume ?? 0;
  const openInterest = contract.openInterest ?? 0;
  const iv = contract.impliedVolatility;
  const deltaAbs = contract.delta != null ? Math.abs(contract.delta) : null;
  const spread = contract.ask != null && contract.bid != null ? Math.max(contract.ask - contract.bid, 0) : null;
  const mid = contract.midpoint;
  const spreadPct = spread != null && mid > 0 ? spread / mid : null;

  const dte = getDaysToExpiration(contract.expiration);
  const strikeDistancePct = stockPrice != null && contract.strike != null ? Math.abs(contract.strike - stockPrice) / stockPrice : 1;

  const strikeScore = Math.max(0, 1 - strikeDistancePct / 0.18) * 24;
  const dteScore = dte == null ? 0 : Math.max(0, 1 - Math.abs(dte - targetDte) / 35) * 16;

  let deltaScore = 0;
  if (deltaAbs != null) {
    const distance = Math.abs(deltaAbs - 0.45);
    deltaScore = Math.max(0, 1 - distance / 0.35) * 16;
  }

  const volumeScore = Math.min(volume / 2000, 1) * 14;
  const oiScore = Math.min(openInterest / 5000, 1) * 12;
  const spreadScore = spreadPct == null ? 0 : Math.max(0, 1 - spreadPct / 0.35) * 10;

  let ivScore = 0;
  if (iv != null) {
    const distanceFromIdeal = Math.abs(iv - 0.35);
    ivScore = Math.max(0, 1 - distanceFromIdeal / 0.45) * 8;
  }

  return {
    score: strikeScore + dteScore + deltaScore + volumeScore + oiScore + spreadScore + ivScore,
    details: {
      strikeDistancePct,
      dte,
      spreadPct
    }
  };
}

function buildContractExplanation(contract, analysis, finalScore, band) {
  const pieces = [];
  if (analysis.trend === 'bullish') pieces.push('price trend is bullish above key moving averages');
  if (analysis.setup === 'breakout') pieces.push('chart is pressing recent highs in a breakout structure');
  if (analysis.setup === 'pullback') pieces.push('chart is pulling back into support within an uptrend');
  if ((contract.volume ?? 0) >= 200) pieces.push('contract has usable volume');
  if ((contract.openInterest ?? 0) >= 500) pieces.push('open interest is supportive');
  if (contract.delta != null) pieces.push(`delta is ${contract.delta.toFixed(2)} for directional exposure`);

  return `Estimated setup probability: ${band} (score ${finalScore.toFixed(1)}/100). ${pieces.slice(0, 4).join(', ')}.`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; options-scanner-v2/1.0)'
    }
  });
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new PolygonAccessError(`Polygon request failed (${response.status})`, response.status, details);
  }
  return response.json();
}

async function getStockContext(ticker) {
  const quoteUrl = `${YAHOO_QUOTE_URL}?symbols=${encodeURIComponent(ticker)}`;
  const quoteResult = await fetchJson(quoteUrl);
  const quote = quoteResult?.quoteResponse?.result?.[0];

  if (!quote) {
    throw new Error(`No Yahoo Finance quote found for ticker ${ticker}.`);
  }

  return {
    price:
      toNumber(quote?.regularMarketPrice) ??
      toNumber(quote?.postMarketPrice) ??
      toNumber(quote?.preMarketPrice),
    dailyChangePercent:
      toNumber(quote?.regularMarketChangePercent) ??
      toNumber(quote?.postMarketChangePercent) ??
      toNumber(quote?.preMarketChangePercent),
    marketCap: toNumber(quote?.marketCap),
    companyName: quote?.longName ?? quote?.shortName ?? quote?.displayName ?? ticker
  };
}

async function getDailyBars(ticker) {
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&range=6mo&includePrePost=false&events=div,splits`;
  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];

  if (!result) return [];

  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const opens = Array.isArray(quote?.open) ? quote.open : [];
  const highs = Array.isArray(quote?.high) ? quote.high : [];
  const lows = Array.isArray(quote?.low) ? quote.low : [];
  const closes = Array.isArray(quote?.close) ? quote.close : [];
  const volumes = Array.isArray(quote?.volume) ? quote.volume : [];

  return timestamps
    .map((ts, idx) => ({
      t: toNumber(ts) != null ? Number(ts) * 1000 : null,
      o: toNumber(opens[idx]),
      h: toNumber(highs[idx]),
      l: toNumber(lows[idx]),
      c: toNumber(closes[idx]),
      v: toNumber(volumes[idx])
    }))
    .filter((bar) => bar.t != null && [bar.o, bar.h, bar.l, bar.c].every((value) => value != null));
}

function calculateRsi(closes, period = 14) {
  if (closes.length <= period) return null;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    const currentGain = Math.max(change, 0);
    const currentLoss = Math.max(-change, 0);
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateAtr(bars, period = 14) {
  if (bars.length <= period) return null;
  const trueRanges = [];

  for (let i = 1; i < bars.length; i += 1) {
    const high = bars[i].h;
    const low = bars[i].l;
    const prevClose = bars[i - 1].c;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  return average(trueRanges.slice(-period));
}

function analyzeChart(bars) {
  if (!bars.length) {
    return {
      hasData: false,
      price: null,
      high5: null,
      low5: null,
      high20: null,
      low20: null,
      high50: null,
      low50: null,
      ma20: null,
      ma50: null,
      rsi: null,
      atr: null,
      trend: 'neutral',
      setup: 'weak trend',
      entryQuality: 'Low',
      buyZone: 'N/A',
      invalidation: 'N/A',
      target: 'N/A'
    };
  }

  const closes = bars.map((b) => b.c).filter((v) => v != null);
  const highs = bars.map((b) => b.h).filter((v) => v != null);
  const lows = bars.map((b) => b.l).filter((v) => v != null);

  const lastClose = closes.at(-1) ?? null;
  const ma20 = average(closes.slice(-20));
  const ma50 = average(closes.slice(-50));
  const prevMa20 = average(closes.slice(-21, -1));
  const slope20 = ma20 != null && prevMa20 != null ? ma20 - prevMa20 : null;

  const analysis = {
    hasData: true,
    price: lastClose,
    high5: highest(highs.slice(-5)),
    low5: lowest(lows.slice(-5)),
    high20: highest(highs.slice(-20)),
    low20: lowest(lows.slice(-20)),
    high50: highest(highs.slice(-50)),
    low50: lowest(lows.slice(-50)),
    ma20,
    ma50,
    rsi: calculateRsi(closes, 14),
    atr: calculateAtr(bars, 14),
    trend: 'neutral',
    setup: 'weak trend',
    entryQuality: 'Low',
    buyZone: 'N/A',
    invalidation: 'N/A',
    target: 'N/A'
  };

  analysis.trend = classifyTrend({ price: analysis.price, ma20: analysis.ma20, ma50: analysis.ma50, slope20 });
  analysis.setup = classifySetup(analysis);

  const plan = estimateEntryPlan(analysis);
  analysis.entryQuality = plan.entryQuality;
  analysis.buyZone = plan.buyZone;
  analysis.invalidation = plan.invalidation;
  analysis.target = plan.target;

  return analysis;
}

async function getOptionsChain(ticker, apiKey) {
  let nextUrl = `${API_BASE}/v3/snapshot/options/${ticker}?limit=250&apiKey=${apiKey}`;
  const results = [];
  let safetyCounter = 0;

  while (nextUrl && safetyCounter < 4) {
    const data = await fetchJson(nextUrl);
    if (Array.isArray(data?.results)) results.push(...data.results);
    nextUrl = data?.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
    safetyCounter += 1;
  }

  return results.map(normalizeContract);
}

function formatFutureDate(daysAhead) {
  const target = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return target.toISOString().slice(0, 10);
}

function createMockContract({ ticker, expiration, strike, stockPrice, priceFactor }) {
  const intrinsic = Math.max(stockPrice - strike, 0);
  const timeValue = Math.max(stockPrice * priceFactor, 0.15);
  const midpoint = Number((intrinsic * 0.18 + timeValue).toFixed(2));
  const bid = Number(Math.max(midpoint - 0.08, 0.01).toFixed(2));
  const ask = Number((midpoint + 0.08).toFixed(2));
  const iv = Number((0.22 + Math.abs(strike - stockPrice) / stockPrice).toFixed(3));

  return {
    ticker: `MOCK-${ticker}-${expiration.replaceAll('-', '')}-C${Math.round(strike)}`,
    contractType: 'call',
    strike: Number(strike.toFixed(2)),
    expiration,
    bid,
    ask,
    lastPrice: midpoint,
    volume: Math.round(80 + (stockPrice / strike) * 120),
    openInterest: Math.round(180 + (stockPrice / strike) * 260),
    impliedVolatility: iv,
    delta: Number((0.35 + (stockPrice - strike) / stockPrice).toFixed(3)),
    midpoint,
    dataSource: 'mock'
  };
}

function buildMockContracts(ticker, stockPrice) {
  const basePrice = stockPrice && stockPrice > 0 ? stockPrice : 100;
  const expirations = [formatFutureDate(30), formatFutureDate(60)];
  const strikeSteps = [0.9, 0.95, 1, 1.05, 1.1];
  const contracts = [];

  for (const expiration of expirations) {
    for (const step of strikeSteps) {
      const strike = basePrice * step;
      contracts.push(createMockContract({ ticker, expiration, strike, stockPrice: basePrice, priceFactor: 0.012 }));
    }
  }

  return contracts;
}

async function getOptionsData(ticker, apiKey, stockPrice) {
  try {
    const contracts = await getOptionsChain(ticker, apiKey);
    return {
      contracts: contracts.filter((c) => c.contractType === 'call').map((c) => ({ ...c, dataSource: 'polygon' })),
      restrictionMessage: ''
    };
  } catch (error) {
    if (error instanceof PolygonAccessError && error.status === 403) {
      return {
        contracts: buildMockContracts(ticker, stockPrice),
        restrictionMessage:
          'Live options chain data is restricted on your Polygon plan (HTTP 403). Showing chart analysis + fallback simulated call contracts.'
      };
    }

    throw error;
  }
}

function buildRecommendations(contracts, stockPrice, analysis) {
  const windows = [
    { key: 'bestOneMonth', label: 'Best 1-Month Call', minDte: 20, maxDte: 45, targetDte: 32 },
    { key: 'bestTwoMonth', label: 'Best 2-Month Call', minDte: 46, maxDte: 80, targetDte: 62 }
  ];

  const chartScore = scoreChartQuality(analysis);

  const picked = {};

  for (const window of windows) {
    const ranked = contracts
      .map((contract) => {
        const { score: contractScore, details } = scoreContractQuality(contract, stockPrice, window.targetDte);
        const finalScore = chartScore * 0.58 + contractScore * 0.42;
        const band = probabilityBand(finalScore);
        return {
          ...contract,
          score: finalScore,
          contractQualityScore: contractScore,
          chartQualityScore: chartScore,
          estimatedSetupProbability: band,
          chartSetupType: analysis.setup,
          trend: analysis.trend,
          buyZone: analysis.buyZone,
          invalidation: analysis.invalidation,
          target: analysis.target,
          entryQuality: analysis.entryQuality,
          reasoning: buildContractExplanation(contract, analysis, finalScore, band),
          strikeDistancePct: details.strikeDistancePct,
          dte: details.dte,
          spreadPct: details.spreadPct
        };
      })
      .filter((c) => c.dte != null && c.dte >= window.minDte && c.dte <= window.maxDte)
      .sort((a, b) => b.score - a.score);

    picked[window.key] = ranked[0] ? { ...ranked[0], score: ranked[0].score.toFixed(1) } : null;
  }

  return picked;
}

function RecommendationCard({ title, contract }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, flex: 1, minWidth: 260 }}>
      <h3 style={{ marginTop: 0, marginBottom: 10 }}>{title}</h3>
      {contract ? (
        <>
          <p style={{ margin: '0 0 8px 0', fontWeight: 700 }}>{contract.ticker}</p>
          <p style={{ margin: '0 0 8px 0', color: '#374151' }}>
            Strike {formatCurrency(contract.strike)} · Exp {contract.expiration} · Delta {contract.delta != null ? contract.delta.toFixed(2) : 'N/A'}
          </p>
          <p style={{ margin: '0 0 8px 0', color: '#374151' }}>
            Bid/Ask {formatCurrency(contract.bid)} / {formatCurrency(contract.ask)} · IV {contract.impliedVolatility != null ? contract.impliedVolatility.toFixed(2) : 'N/A'}
          </p>
          <p style={{ margin: '0 0 8px 0', color: '#111827', fontWeight: 600 }}>Estimated setup probability: {contract.estimatedSetupProbability}</p>
          <p style={{ margin: '0 0 6px 0', color: '#374151' }}>
            Setup {contract.chartSetupType} · Buy Zone {contract.buyZone}
          </p>
          <p style={{ margin: '0 0 6px 0', color: '#374151' }}>
            Invalidation {contract.invalidation} · Target {contract.target}
          </p>
          <p style={{ margin: 0, color: '#4b5563' }}>{contract.reasoning}</p>
        </>
      ) : (
        <p style={{ margin: 0, color: '#6b7280' }}>No contract met this expiration window with current filters/liquidity.</p>
      )}
    </div>
  );
}

function ChartSummaryPanel({ stock, analysis, barsCount }) {
  return (
    <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <h2 style={{ marginTop: 0, marginBottom: 10 }}>Chart Summary ({barsCount} daily bars)</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <Stat label="Current Price" value={formatCurrency(stock.price ?? analysis.price)} />
        <Stat label="Trend" value={analysis.trend} />
        <Stat label="Setup" value={analysis.setup} />
        <Stat label="Entry Quality" value={analysis.entryQuality} />
        <Stat label="5D High / Low" value={`${formatCurrency(analysis.high5)} / ${formatCurrency(analysis.low5)}`} />
        <Stat label="20D High / Low" value={`${formatCurrency(analysis.high20)} / ${formatCurrency(analysis.low20)}`} />
        <Stat label="50D High / Low" value={`${formatCurrency(analysis.high50)} / ${formatCurrency(analysis.low50)}`} />
        <Stat label="MA20 / MA50" value={`${formatCurrency(analysis.ma20)} / ${formatCurrency(analysis.ma50)}`} />
        <Stat label="RSI" value={analysis.rsi != null ? analysis.rsi.toFixed(1) : 'N/A'} />
        <Stat label="ATR" value={formatCurrency(analysis.atr)} />
        <Stat label="Buy Zone" value={analysis.buyZone} />
        <Stat label="Invalidation / Target" value={`${analysis.invalidation} / ${analysis.target}`} />
      </div>
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ border: '1px solid #f3f4f6', borderRadius: 10, padding: 10 }}>
      <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export default async function HomePage({ searchParams }) {
  const apiKey = process.env.POLYGON_API_KEY;
  const ticker = (searchParams?.ticker || 'AAPL').trim().toUpperCase();

  if (!apiKey) {
    return (
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
        <h1>Options Recommendation Engine</h1>
        <p style={{ color: '#b91c1c' }}>POLYGON_API_KEY is not set. Add it to your environment variables before using the scanner.</p>
      </main>
    );
  }

  let stock = { price: null, dailyChangePercent: null, marketCap: null, companyName: ticker };
  let bars = [];
  let contracts = [];
  let restrictionMessage = '';
  let errorMessage = '';

  try {
    stock = await getStockContext(ticker);
    bars = await getDailyBars(ticker);
    const optionsData = await getOptionsData(ticker, apiKey, stock.price);
    contracts = optionsData.contracts;
    restrictionMessage = optionsData.restrictionMessage;
  } catch (error) {
    errorMessage = error.message || 'Failed to load recommendation engine data.';
  }

  const analysis = analyzeChart(bars);
  const recommendations = buildRecommendations(contracts, stock.price ?? analysis.price, analysis);

  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <h1 style={{ marginBottom: 6 }}>Chart-Aware Options Recommendation Engine</h1>
      <p style={{ marginTop: 0, color: '#4b5563' }}>
        Uses Yahoo Finance stock/chart data and Polygon options chain data to estimate setup quality for call contracts. “Estimated setup probability” is a scoring band, not a calibrated statistical probability.
      </p>

      <form method="GET" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <input
          id="ticker"
          name="ticker"
          defaultValue={ticker}
          placeholder="Search ticker (AAPL)"
          style={{ width: 240, padding: 10, borderRadius: 8, border: '1px solid #d1d5db' }}
        />
        <button type="submit" style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: '#111827', color: '#fff', cursor: 'pointer' }}>
          Analyze
        </button>
      </form>

      {errorMessage ? (
        <div style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 10, padding: 12, marginBottom: 16 }}>{errorMessage}</div>
      ) : null}
      {restrictionMessage ? (
        <div style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 10, padding: 12, marginBottom: 16 }}>{restrictionMessage}</div>
      ) : null}

      <section style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, minWidth: 220 }}>
          <div style={{ color: '#6b7280', marginBottom: 8 }}>Ticker</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{stock.companyName}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, minWidth: 220 }}>
          <div style={{ color: '#6b7280', marginBottom: 8 }}>Starting Snapshot Price</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{formatCurrency(stock.price ?? analysis.price)}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, minWidth: 220 }}>
          <div style={{ color: '#6b7280', marginBottom: 8 }}>Daily Change</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: (stock.dailyChangePercent ?? 0) >= 0 ? '#047857' : '#b91c1c' }}>{formatPercent(stock.dailyChangePercent)}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, minWidth: 220 }}>
          <div style={{ color: '#6b7280', marginBottom: 8 }}>Market Cap</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{formatCompactNumber(stock.marketCap)}</div>
        </div>
      </section>

      <LivePricePanel ticker={ticker} initialPrice={stock.price ?? analysis.price} initialDailyChangePercent={stock.dailyChangePercent} />

      <ChartSummaryPanel stock={stock} analysis={analysis} barsCount={bars.length} />

      <section style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <RecommendationCard title="Best 1-Month Call" contract={recommendations.bestOneMonth} />
        <RecommendationCard title="Best 2-Month Call" contract={recommendations.bestTwoMonth} />
      </section>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', background: '#f9fafb' }}>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Contract</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Strike</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Expiration</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Bid</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Ask</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Last</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Volume</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Open Interest</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>IV</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Delta</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>DTE</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Source</th>
            </tr>
          </thead>
          <tbody>
            {contracts.length > 0 ? (
              contracts.map((contract) => (
                <tr key={contract.ticker}>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6', fontFamily: 'monospace', fontSize: 12 }}>{contract.ticker}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{formatCurrency(contract.strike)}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.expiration ?? 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{formatCurrency(contract.bid)}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{formatCurrency(contract.ask)}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{formatCurrency(contract.lastPrice)}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.volume ?? 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.openInterest ?? 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.impliedVolatility != null ? contract.impliedVolatility.toFixed(3) : 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.delta != null ? contract.delta.toFixed(3) : 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{getDaysToExpiration(contract.expiration) ?? 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.dataSource ?? 'polygon'}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={12} style={{ padding: 14, color: '#6b7280' }}>
                  No call contracts available. Chart analysis still shown above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
