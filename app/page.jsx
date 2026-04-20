import LivePricePanel from './components/LivePricePanel';
const API_BASE = 'https://api.polygon.io';
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

function percentChange(fromValue, toValue) {
  if (fromValue == null || toValue == null || fromValue === 0) return null;
  return ((toValue - fromValue) / fromValue) * 100;
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

function toSetupProbabilityScore(analysis) {
  const chartScore = scoreChartQuality(analysis);
  const setupLabel = analysis?.intradaySignals?.setupLabel ?? analysis?.setup ?? 'weak trend';
  const momentumLabel = analysis?.intradaySignals?.momentumLabel ?? 'weak';

  let adjusted = chartScore;
  if (setupLabel === 'breakout') adjusted += 4;
  else if (setupLabel === 'pullback') adjusted += 2;
  else if (setupLabel === 'weak trend') adjusted -= 8;

  if (momentumLabel === 'strong') adjusted += 3;
  else if (momentumLabel === 'weak') adjusted -= 2;

  return clamp(adjusted, 5, 95);
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

  let qualityPenalty = 0;
  const strikeVsSpotPct = stockPrice != null && contract.strike != null && stockPrice !== 0 ? ((contract.strike - stockPrice) / stockPrice) * 100 : null;
  if (strikeVsSpotPct != null && strikeVsSpotPct < -10) qualityPenalty += Math.min(18, Math.abs(strikeVsSpotPct + 10) * 1.2);
  if (deltaAbs != null && deltaAbs > 0.85) qualityPenalty += Math.min(20, (deltaAbs - 0.85) * 120);
  if (deltaAbs != null && deltaAbs < 0.2) qualityPenalty += 8;
  if (spreadPct == null) qualityPenalty += 10;
  if (contract.bid == null || contract.ask == null) qualityPenalty += 10;
  if (volume < 25) qualityPenalty += 8;
  if (openInterest < 100) qualityPenalty += 8;

  return {
    score: Math.max(1, strikeScore + dteScore + deltaScore + volumeScore + oiScore + spreadScore + ivScore - qualityPenalty),
    details: {
      strikeDistancePct,
      strikeVsSpotPct,
      dte,
      spreadPct,
      volume,
      openInterest
    }
  };
}

function confidenceFromScores({ setupProbabilityScore, contractScore, setupLabel, momentumLabel, shortMovePercent }) {
  if (setupProbabilityScore < 50 || contractScore < 45) return 'Low';
  if (setupLabel === 'weak trend') return 'Low';
  if (setupProbabilityScore >= 80 && contractScore >= 75 && setupLabel === 'breakout' && momentumLabel === 'strong') return 'High';
  if (setupProbabilityScore >= 65 && contractScore >= 60) return 'Moderate-High';
  if (setupLabel === 'pullback' && (shortMovePercent ?? 0) >= -2 && contractScore >= 50) return 'Moderate';
  return 'Moderate';
}

function buildContractExplanation(contract, analysis, scorePack) {
  const { strikeVsSpotPct, dte, spreadPct, liquidityLabel } = scorePack;
  const signals = analysis?.intradaySignals ?? {};
  const setupLabel = signals.setupLabel ?? analysis.setup ?? 'weak trend';
  const momentumLabel = signals.momentumLabel ?? 'weak';
  const strikeDistanceText =
    strikeVsSpotPct == null
      ? 'strike distance is unavailable'
      : strikeVsSpotPct >= 0
        ? `strike is ${strikeVsSpotPct.toFixed(1)}% OTM`
        : `strike is ${Math.abs(strikeVsSpotPct).toFixed(1)}% ITM`;

  const spreadText = spreadPct == null ? 'spread not available' : `spread is ${(spreadPct * 100).toFixed(1)}% of mid`;
  const dteText = dte == null ? 'expiration not available' : `${dte} DTE fits the target window`;

  return {
    setup: `${setupLabel} with ${momentumLabel} momentum`,
    momentum: `${momentumLabel} momentum, ${(signals.shortMovePercent ?? 0).toFixed(1)}% move over last 5 bars`,
    strikeFit: strikeDistanceText,
    expirationFit: dteText,
    liquidity: `${liquidityLabel} liquidity, ${spreadText}`
  };
}

function scoreWithSetupSignals(contract, stockPrice, targetDte, analysis) {
  const base = scoreContractQuality(contract, stockPrice, targetDte);
  const signals = analysis?.intradaySignals ?? {};
  const setupLabel = signals.setupLabel ?? analysis.setup ?? 'weak trend';
  const momentumLabel = signals.momentumLabel ?? 'weak';
  const shortMovePercent = signals.shortMovePercent;
  const recentHigh = signals.recentHigh;
  const recentLow = signals.recentLow;
  const supportReference = signals.supportReference;

  let setupAdjustment = 0;
  const strikeVsSpotPct = base.details.strikeVsSpotPct;

  if (setupLabel === 'breakout' && momentumLabel === 'strong') {
    if (strikeVsSpotPct != null) {
      const distanceFromPreferred = Math.abs(strikeVsSpotPct - 3);
      setupAdjustment += Math.max(0, 1 - distanceFromPreferred / 8) * 12;
      if (strikeVsSpotPct < -3) setupAdjustment -= 6;
      if (strikeVsSpotPct > 10) setupAdjustment -= 5;
    }
    if (base.details.dte != null) setupAdjustment += Math.max(0, 1 - Math.abs(base.details.dte - targetDte) / 26) * 6;
  } else if (setupLabel === 'pullback') {
    if (strikeVsSpotPct != null) {
      const distanceFromPreferred = Math.abs(strikeVsSpotPct + 1);
      setupAdjustment += Math.max(0, 1 - distanceFromPreferred / 7) * 11;
      if (strikeVsSpotPct > 7) setupAdjustment -= 8;
    }
    if (base.details.dte != null) setupAdjustment += Math.max(0, 1 - Math.abs(base.details.dte - (targetDte + 5)) / 28) * 6;
  } else if (setupLabel === 'weak trend') {
    setupAdjustment -= 8;
    if (strikeVsSpotPct != null && strikeVsSpotPct > 5) setupAdjustment -= 10;
  }

  if (recentHigh != null && stockPrice != null && contract.strike != null && setupLabel === 'breakout' && contract.strike > recentHigh * 1.08) {
    setupAdjustment -= 4;
  }
  if (recentLow != null && supportReference != null && shortMovePercent != null && setupLabel === 'pullback') {
    if (stockPrice != null && stockPrice < supportReference) setupAdjustment -= 5;
    if (shortMovePercent < -3) setupAdjustment -= 3;
    if (recentLow > 0 && supportReference / recentLow > 1.05) setupAdjustment -= 2;
  }

  const liquidityComposite = (base.details.volume ?? 0) + (base.details.openInterest ?? 0) * 0.2;
  const liquidityLabel = liquidityComposite >= 1200 ? 'strong' : liquidityComposite >= 450 ? 'solid' : 'light';
  const confidenceLabel = confidenceFromScores({
    setupProbabilityScore: 0,
    contractScore: clamp(base.score + setupAdjustment, 1, 100),
    setupLabel,
    momentumLabel,
    shortMovePercent
  });

  return {
    baseScore: base.score,
    setupAdjustment,
    contractScore: clamp(base.score + setupAdjustment, 1, 100),
    details: { ...base.details, setupLabel, momentumLabel, liquidityLabel, confidenceLabel }
  };
}

function isValidContractCore(contract, stockPrice) {
  if (!contract?.expiration || contract?.strike == null || stockPrice == null || stockPrice <= 0) return false;
  if (contract.strike <= 0) return false;
  if (contract.impliedVolatility != null && contract.impliedVolatility <= 0) return false;
  if (contract.delta != null && (contract.delta < 0 || contract.delta > 1)) return false;
  return true;
}

function applyWindowCandidateFilters(contracts, stockPrice, window, strictMode) {
  const inWindow = contracts.filter((c) => {
    const dte = getDaysToExpiration(c.expiration);
    return dte != null && dte >= window.minDte && dte <= window.maxDte;
  });
  const coreValid = inWindow.filter((c) => isValidContractCore(c, stockPrice));
  if (!strictMode) return coreValid;

  const moneynessValid = coreValid.filter((c) => {
    const strikeVsSpotPct = ((c.strike - stockPrice) / stockPrice) * 100;
    return strikeVsSpotPct >= -15 && strikeVsSpotPct <= 15;
  });
  if (!moneynessValid.length) return [];

  const preferredDelta = moneynessValid.filter((c) => c.delta == null || (c.delta >= 0.25 && c.delta <= 0.85));
  return preferredDelta.length ? preferredDelta : moneynessValid;
}

async function fetchPolygonJson(url) {
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

async function fetchChartJson(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; options-scanner-v2/1.0)'
    }
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    const error = new Error(`Daily chart request failed (${response.status})`);
    error.status = response.status;
    error.details = details;
    throw error;
  }

  return response.json();
}

async function getDailyBars(ticker) {
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&range=6mo&includePrePost=false&events=div,splits`;
  const data = await fetchChartJson(url);
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


function buildStockSnapshotFromBars(ticker, bars) {
  const closes = bars.map((bar) => bar.c).filter((value) => value != null);
  const latest = closes.at(-1) ?? null;
  const previous = closes.at(-2) ?? null;

  return {
    price: latest,
    dailyChangePercent: previous ? ((latest - previous) / previous) * 100 : null,
    companyName: ticker,
    stockSourceLabel: 'Delayed daily stock data',
    stockFreshnessLabel: 'Delayed / last close'
  };
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

function buildIntradaySignals({ bars, trend, ma20 }) {
  if (bars.length < 21) {
    return {
      setupLabel: null,
      momentumLabel: null,
      recentHigh: null,
      recentLow: null,
      shortMovePercent: null,
      supportReference: null,
      insufficientData: true
    };
  }

  const closes = bars.map((bar) => bar.c).filter((value) => value != null);
  const highs = bars.map((bar) => bar.h).filter((value) => value != null);
  const lows = bars.map((bar) => bar.l).filter((value) => value != null);

  const latestClose = closes.at(-1) ?? null;
  const prior20High = highest(highs.slice(-21, -1));
  const recentHigh = highest(highs.slice(-20));
  const recentLow = lowest(lows.slice(-20));
  const shortMovePercent = percentChange(closes.at(-6), latestClose);
  const supportReference = ma20 ?? recentLow;

  const breakout = latestClose != null && prior20High != null ? latestClose > prior20High : false;
  const pullback =
    latestClose != null && supportReference != null && supportReference > 0
      ? latestClose >= supportReference && latestClose <= supportReference * 1.015 && trend !== 'bearish'
      : false;

  let setupLabel = 'weak trend';
  if (breakout) setupLabel = 'breakout';
  else if (pullback) setupLabel = 'pullback';

  let momentumLabel = 'weak';
  if ((shortMovePercent ?? 0) >= 3) momentumLabel = 'strong';
  else if ((shortMovePercent ?? 0) >= 1.5) momentumLabel = 'moderate';

  return {
    setupLabel,
    momentumLabel,
    recentHigh,
    recentLow,
    shortMovePercent,
    supportReference,
    insufficientData: false
  };
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
      target: 'N/A',
      intradaySignals: {
        setupLabel: null,
        momentumLabel: null,
        recentHigh: null,
        recentLow: null,
        shortMovePercent: null,
        supportReference: null,
        insufficientData: true
      }
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
  analysis.intradaySignals = buildIntradaySignals({ bars, trend: analysis.trend, ma20: analysis.ma20 });
  if (analysis.intradaySignals?.setupLabel) {
    analysis.setup = analysis.intradaySignals.setupLabel;
  }

  return analysis;
}

async function getOptionsChain(ticker, apiKey) {
  let nextUrl = `${API_BASE}/v3/snapshot/options/${ticker}?limit=250&apiKey=${apiKey}`;
  const results = [];
  let safetyCounter = 0;

  while (nextUrl && safetyCounter < 4) {
    const data = await fetchPolygonJson(nextUrl);
    if (Array.isArray(data?.results)) results.push(...data.results);
    nextUrl = data?.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
    safetyCounter += 1;
  }

  return results.map(normalizeContract);
}

async function getOptionsData(ticker, apiKey) {
  try {
    const contracts = await getOptionsChain(ticker, apiKey);
    return {
      contracts: contracts.filter((c) => c.contractType === 'call').map((c) => ({ ...c, dataSource: 'polygon' })),
      restrictionMessage: ''
    };
  } catch (error) {
    if (error instanceof PolygonAccessError && (error.status === 401 || error.status === 403)) {
      const code = error.status;
      return {
        contracts: [],
        restrictionMessage:
          code === 401
            ? 'Polygon options request failed with HTTP 401. Verify POLYGON_API_KEY in Vercel Project Settings and redeploy. Chart analysis remains available with delayed daily stock data.'
            : 'Live options chain data is restricted on your Polygon plan (HTTP 403). Chart analysis remains available with delayed daily stock data.'
      };
    }

    throw error;
  }
}

function buildRecommendations(contracts, stockPrice, analysis) {
  const windows = [
    { key: 'best1MonthCall', label: 'Best 1-Month Call', minDte: 20, maxDte: 45, targetDte: 32, strict: false },
    { key: 'best2MonthCall', label: 'Best 2-Month Call', minDte: 46, maxDte: 80, targetDte: 62, strict: true }
  ];

  const setupProbabilityScore = toSetupProbabilityScore(analysis);
  const setupBand = probabilityBand(setupProbabilityScore);

  const picked = {};

  for (const window of windows) {
    const filteredContracts = applyWindowCandidateFilters(contracts, stockPrice, window, window.strict);
    const ranked = filteredContracts
      .map((contract) => {
        const setupAwareScore = scoreWithSetupSignals(contract, stockPrice, window.targetDte, analysis);
        const contractScore = setupAwareScore.contractScore;
        const signals = analysis?.intradaySignals ?? {};
        const confidenceLabel = confidenceFromScores({
          setupProbabilityScore,
          contractScore,
          setupLabel: signals.setupLabel ?? analysis.setup ?? 'weak trend',
          momentumLabel: signals.momentumLabel ?? 'weak',
          shortMovePercent: signals.shortMovePercent
        });
        const contractReasoning = buildContractExplanation(contract, analysis, {
          strikeVsSpotPct: setupAwareScore.details.strikeVsSpotPct,
          dte: setupAwareScore.details.dte,
          spreadPct: setupAwareScore.details.spreadPct,
          liquidityLabel: setupAwareScore.details.liquidityLabel
        });
        return {
          ...contract,
          score: contractScore,
          finalCompositeScore: Number(contractScore.toFixed(1)),
          contractScore: Number(contractScore.toFixed(1)),
          chartQualityScore: setupProbabilityScore,
          confidenceLabel,
          chartSetupType: analysis?.intradaySignals?.setupLabel ?? analysis.setup,
          trend: analysis.trend,
          buyZone: analysis.buyZone,
          invalidation: analysis.invalidation,
          target: analysis.target,
          entryQuality: analysis.entryQuality,
          estimatedSetupProbability: setupBand,
          contractReasoning,
          strikeDistancePct: setupAwareScore.details.strikeDistancePct,
          strikeVsSpotPct: setupAwareScore.details.strikeVsSpotPct,
          dte: setupAwareScore.details.dte,
          spreadPct: setupAwareScore.details.spreadPct
        };
      })
      .sort((a, b) => b.score - a.score);

    picked[window.key] = ranked[0] ?? null;
  }

  picked.bestOneMonth = picked.best1MonthCall;
  picked.bestTwoMonth = picked.best2MonthCall;
  return picked;
}

function RecommendationCard({ title, contract }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, flex: 1, minWidth: 260 }}>
      <h3 style={{ marginTop: 0, marginBottom: 10 }}>{title}</h3>
      {contract ? (
        <>
          <p style={{ margin: '0 0 8px 0', fontWeight: 700 }}>{contract.ticker}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 10 }}>
            <Stat label="Setup Probability" value={contract.estimatedSetupProbability} />
            <Stat label="Contract Score" value={contract.contractScore ?? 'N/A'} />
            <Stat label="Confidence" value={contract.confidenceLabel ?? 'N/A'} />
          </div>
          <div style={{ border: '1px solid #f3f4f6', borderRadius: 10, padding: 10, marginBottom: 10, color: '#374151' }}>
            <div style={{ marginBottom: 4 }}>Strike: {formatCurrency(contract.strike)}</div>
            <div style={{ marginBottom: 4 }}>Expiration: {contract.expiration ?? 'N/A'}</div>
            <div style={{ marginBottom: 4 }}>Delta: {contract.delta != null ? contract.delta.toFixed(2) : 'N/A'}</div>
            <div style={{ marginBottom: 4 }}>IV: {contract.impliedVolatility != null ? contract.impliedVolatility.toFixed(2) : 'N/A'}</div>
            <div>Bid/Ask: {formatCurrency(contract.bid)} / {formatCurrency(contract.ask)}</div>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#4b5563', lineHeight: 1.4 }}>
            <li><strong>Setup:</strong> {contract.contractReasoning.setup}</li>
            <li><strong>Momentum:</strong> {contract.contractReasoning.momentum}</li>
            <li><strong>Strike Fit:</strong> {contract.contractReasoning.strikeFit}</li>
            <li><strong>Expiration Fit:</strong> {contract.contractReasoning.expirationFit}</li>
            <li><strong>Liquidity:</strong> {contract.contractReasoning.liquidity}</li>
          </ul>
        </>
      ) : (
        <p style={{ margin: 0, color: '#6b7280' }}>No suitable contract found for this window under current quality filters.</p>
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

function SignalSummaryPanel({ signals }) {
  const notEnoughData = signals?.insufficientData || !signals?.setupLabel;
  return (
    <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <h2 style={{ marginTop: 0, marginBottom: 10 }}>Intraday Signal Snapshot (from delayed chart bars)</h2>
      {notEnoughData ? (
        <p style={{ margin: 0, color: '#6b7280' }}>Not enough data</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <Stat label="Setup Label" value={signals.setupLabel} />
          <Stat label="Momentum Label" value={signals.momentumLabel} />
          <Stat label="Short Move (5 bars)" value={formatPercent(signals.shortMovePercent)} />
          <Stat label="Recent High (20 bars)" value={formatCurrency(signals.recentHigh)} />
          <Stat label="Recent Low (20 bars)" value={formatCurrency(signals.recentLow)} />
          <Stat label="Support Reference" value={formatCurrency(signals.supportReference)} />
        </div>
      )}
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
  const apiKey = process.env.POLYGON_API_KEY?.trim();
  const ticker = (searchParams?.ticker || 'AAPL').trim().toUpperCase();

  if (!apiKey) {
    return (
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
        <h1>Options Recommendation Engine</h1>
        <p style={{ color: '#b91c1c' }}>POLYGON_API_KEY is not set. Add it to your environment variables before using the scanner.</p>
      </main>
    );
  }

  let stock = {
    price: null,
    dailyChangePercent: null,
    companyName: ticker,
    stockSourceLabel: 'Delayed daily stock data',
    stockFreshnessLabel: 'Delayed / last close'
  };
  let bars = [];
  let contracts = [];
  let restrictionMessage = '';
  const notices = [];

  try {
    bars = await getDailyBars(ticker);
    stock = buildStockSnapshotFromBars(ticker, bars);
  } catch (error) {
    notices.push(`Stock chart data unavailable: ${error.message || 'unknown error'}.`);
  }

  try {
    const optionsData = await getOptionsData(ticker, apiKey);
    contracts = optionsData.contracts;
    restrictionMessage = optionsData.restrictionMessage;
  } catch (error) {
    notices.push(`Options chain unavailable: ${error.message || 'unknown error'}.`);
  }

  const analysis = analyzeChart(bars);
  const recommendations = buildRecommendations(contracts, stock.price ?? analysis.price, analysis);

  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <h1 style={{ marginBottom: 6 }}>Chart-Aware Options Recommendation Engine</h1>
      <p style={{ marginTop: 0, color: '#4b5563' }}>
        Uses Polygon options chain data and delayed daily stock/chart data to estimate setup quality for call contracts. “Estimated setup probability” is a scoring band, not a calibrated statistical probability.
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

      {notices.length ? (
        <div style={{ background: '#f9fafb', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginBottom: 16 }}>
          {notices.map((notice) => (
            <p key={notice} style={{ margin: '0 0 6px 0' }}>
              {notice}
            </p>
          ))}
        </div>
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
          <div style={{ color: '#6b7280', marginBottom: 8 }}>Stock Source</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{stock.stockSourceLabel}</div>
          <div style={{ color: '#6b7280', marginTop: 6 }}>{stock.stockFreshnessLabel}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, minWidth: 220 }}>
          <div style={{ color: '#6b7280', marginBottom: 8 }}>Options Source</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Polygon options</div>
        </div>
      </section>

      <LivePricePanel ticker={ticker} initialPrice={stock.price ?? analysis.price} initialDailyChangePercent={stock.dailyChangePercent} />

      <ChartSummaryPanel stock={stock} analysis={analysis} barsCount={bars.length} />
      <SignalSummaryPanel signals={analysis.intradaySignals} />

      <section style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <RecommendationCard title="Best 1-Month Call" contract={recommendations.best1MonthCall} />
        <RecommendationCard title="Best 2-Month Call" contract={recommendations.best2MonthCall} />
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
