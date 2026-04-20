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
  const closes = Array.isArray(quote?.close) ? quote.close.map(toNumber) : [];

  const points = timestamps
    .map((ts, idx) => ({
      timestamp: toNumber(ts),
      close: closes[idx]
    }))
    .filter((point) => point.timestamp != null && point.close != null);

  return points;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get('ticker') || 'AAPL').trim().toUpperCase();

  const fallbackPayload = {
    ticker,
    price: null,
    dailyChangePercent: null,
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

    return NextResponse.json({
      ticker,
      price: latest.close,
      dailyChangePercent,
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
