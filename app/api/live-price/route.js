import { NextResponse } from 'next/server';

const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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
    const error = new Error(`Daily chart request failed (${response.status})`);
    error.status = response.status;
    error.details = details;
    throw error;
  }

  return response.json();
}

function extractDailySeries(data) {
  const result = data?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const highs = Array.isArray(quote?.high) ? quote.high.map(toNumber) : [];
  const lows = Array.isArray(quote?.low) ? quote.low.map(toNumber) : [];
  const closes = Array.isArray(quote?.close) ? quote.close.map(toNumber) : [];

  const points = timestamps
    .map((ts, idx) => ({
      timestamp: toNumber(ts),
      high: highs[idx],
      low: lows[idx],
      close: closes[idx]
    }))
    .filter((point) => point.timestamp != null && point.close != null && point.high != null && point.low != null);

  return points;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function percentChange(fromValue, toValue) {
  if (fromValue == null || toValue == null || fromValue === 0) return null;
  return ((toValue - fromValue) / fromValue) * 100;
}

function buildIntradaySignals(series) {
  if (series.length < 21) {
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

  const closes = series.map((bar) => bar.close);
  const highs = series.map((bar) => bar.high);
  const lows = series.map((bar) => bar.low);
  const latestClose = closes.at(-1) ?? null;
  const prior20High = Math.max(...highs.slice(-21, -1));
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const shortMovePercent = percentChange(closes.at(-6), latestClose);
  const ma20 = average(closes.slice(-20));
  const supportReference = ma20 ?? recentLow;
  const trend =
    latestClose != null && ma20 != null ? (latestClose > ma20 ? 'bullish' : latestClose < ma20 ? 'bearish' : 'neutral') : 'neutral';
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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get('ticker') || 'AAPL').trim().toUpperCase();

  const fallbackPayload = {
    ticker,
    price: null,
    dailyChangePercent: null,
    setupLabel: null,
    momentumLabel: null,
    recentHigh: null,
    recentLow: null,
    shortMovePercent: null,
    supportReference: null,
    insufficientData: true,
    source: 'delayed-daily-close',
    sourceLabel: 'Delayed daily stock data',
    freshnessLabel: 'Delayed / last close',
    updatedAt: null,
    stale: true,
    warning: 'Live quote unavailable. Showing delayed daily close when available.'
  };

  try {
    const url = `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?interval=1d&range=1mo&includePrePost=false&events=div,splits`;
    const data = await fetchJson(url);
    const series = extractDailySeries(data);

    if (!series.length) {
      return NextResponse.json(fallbackPayload);
    }

    const latest = series.at(-1);
    const previous = series.at(-2);
    const dailyChangePercent = previous?.close ? ((latest.close - previous.close) / previous.close) * 100 : null;
    const intradaySignals = buildIntradaySignals(series);

    return NextResponse.json({
      ticker,
      price: latest.close,
      dailyChangePercent,
      ...intradaySignals,
      source: 'delayed-daily-close',
      sourceLabel: 'Delayed daily stock data',
      freshnessLabel: 'Delayed / last close',
      updatedAt: new Date(latest.timestamp * 1000).toISOString(),
      stale: true,
      warning: ''
    });
  } catch (error) {
    return NextResponse.json({
      ...fallbackPayload,
      warning: `${fallbackPayload.warning} ${error.message || ''}`.trim()
    });
  }
}
