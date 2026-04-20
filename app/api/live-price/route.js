import { NextResponse } from 'next/server';

const API_BASE = 'https://api.polygon.io';

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    const error = new Error(`Polygon request failed (${response.status})`);
    error.status = response.status;
    error.details = details;
    throw error;
  }

  return response.json();
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function getIntradayContext(ticker, apiKey) {
  const now = new Date();
  const from = new Date(now.getTime() - 8 * 60 * 60 * 1000);
  const url = `${API_BASE}/v2/aggs/ticker/${ticker}/range/1/minute/${isoDate(from)}/${isoDate(now)}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
  const data = await fetchJson(url);
  const bars = Array.isArray(data?.results) ? data.results : [];

  if (!bars.length) {
    return {
      barsCount: 0,
      moveFromOpenPercent: null,
      intradayHigh: null,
      intradayLow: null,
      lastMinuteClose: null
    };
  }

  const open = toNumber(bars[0]?.o);
  const lastClose = toNumber(bars[bars.length - 1]?.c);
  const highs = bars.map((bar) => toNumber(bar.h)).filter((v) => v != null);
  const lows = bars.map((bar) => toNumber(bar.l)).filter((v) => v != null);

  return {
    barsCount: bars.length,
    moveFromOpenPercent: open && lastClose ? ((lastClose - open) / open) * 100 : null,
    intradayHigh: highs.length ? Math.max(...highs) : null,
    intradayLow: lows.length ? Math.min(...lows) : null,
    lastMinuteClose: lastClose
  };
}

export async function GET(request) {
  const apiKey = process.env.POLYGON_API_KEY;
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get('ticker') || 'AAPL').trim().toUpperCase();

  if (!apiKey) {
    return NextResponse.json({ error: 'POLYGON_API_KEY is not set.' }, { status: 500 });
  }

  try {
    const snapshotUrl = `${API_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`;
    const lastTradeUrl = `${API_BASE}/v2/last/trade/${ticker}?apiKey=${apiKey}`;

    const [snapshotResult, lastTradeResult, intradayResult] = await Promise.allSettled([
      fetchJson(snapshotUrl),
      fetchJson(lastTradeUrl),
      getIntradayContext(ticker, apiKey)
    ]);

    const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value?.ticker : null;
    const lastTrade = lastTradeResult.status === 'fulfilled' ? lastTradeResult.value?.results : null;

    const price =
      toNumber(lastTrade?.p) ??
      toNumber(snapshot?.lastTrade?.p) ??
      toNumber(snapshot?.lastQuote?.P) ??
      toNumber(snapshot?.day?.c) ??
      toNumber(snapshot?.prevDay?.c);

    const tradeTimestamp = toNumber(lastTrade?.t ?? snapshot?.lastTrade?.t);

    return NextResponse.json({
      ticker,
      price,
      dailyChangePercent: toNumber(snapshot?.todaysChangePerc),
      marketStatus: snapshot?.market_status ?? null,
      source: lastTradeResult.status === 'fulfilled' ? 'last-trade' : 'snapshot',
      updatedAt: tradeTimestamp ? new Date(tradeTimestamp).toISOString() : new Date().toISOString(),
      intraday:
        intradayResult.status === 'fulfilled'
          ? intradayResult.value
          : {
              barsCount: 0,
              moveFromOpenPercent: null,
              intradayHigh: null,
              intradayLow: null,
              lastMinuteClose: null
            }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error.message || 'Failed to fetch live price.',
        details: error.details || ''
      },
      { status: error.status || 500 }
    );
  }
}
