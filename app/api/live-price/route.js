import { NextResponse } from 'next/server';

const API_BASE = 'https://api.polygon.io';
const DEFAULT_INTRADAY = {
  barsCount: 0,
  moveFromOpenPercent: null,
  intradayHigh: null,
  intradayLow: null,
  lastMinuteClose: null
};

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

function hasValue(value) {
  return value !== null && value !== undefined;
}

function firstNumber(candidates, debugKey, debugBucket) {
  for (const candidate of candidates) {
    const numeric = toNumber(candidate.value);
    if (numeric != null) {
      debugBucket[debugKey] = candidate.label;
      return numeric;
    }
  }

  return null;
}

function firstText(candidates, debugKey, debugBucket) {
  for (const candidate of candidates) {
    if (typeof candidate.value === 'string' && candidate.value.trim()) {
      debugBucket[debugKey] = candidate.label;
      return candidate.value.trim();
    }
  }

  return null;
}

async function getIntradayContext(ticker, apiKey, debug) {
  const now = new Date();
  const from = new Date(now.getTime() - 8 * 60 * 60 * 1000);
  const url = `${API_BASE}/v2/aggs/ticker/${ticker}/range/1/minute/${isoDate(from)}/${isoDate(now)}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
  const data = await fetchJson(url);
  const bars = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.results?.results)
      ? data.results.results
      : [];

  debug.intraday = {
    endpoint: `/v2/aggs/ticker/${ticker}/range/1/minute/...`,
    barsPath: Array.isArray(data?.results)
      ? 'results'
      : Array.isArray(data?.results?.results)
        ? 'results.results'
        : 'none',
    barsCount: bars.length,
    raw: data
  };

  if (!bars.length) {
    return DEFAULT_INTRADAY;
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
  const includeDebug = searchParams.get('debug') !== '0';

  if (!apiKey) {
    return NextResponse.json({ error: 'POLYGON_API_KEY is not set.' }, { status: 500 });
  }

  try {
    const debug = {
      requestedTicker: ticker,
      endpoints: {},
      selectedSources: {},
      fieldsFound: {}
    };
    const snapshotUrl = `${API_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`;
    const lastTradeUrl = `${API_BASE}/v2/last/trade/${ticker}?apiKey=${apiKey}`;

    const [snapshotResult, lastTradeResult, intradayResult] = await Promise.allSettled([
      fetchJson(snapshotUrl),
      fetchJson(lastTradeUrl),
      getIntradayContext(ticker, apiKey, debug.endpoints)
    ]);

    const snapshotPayload = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
    const snapshot =
      snapshotPayload?.ticker ??
      snapshotPayload?.results?.ticker ??
      snapshotPayload?.results ??
      snapshotPayload?.data?.ticker ??
      null;

    const lastTradePayload = lastTradeResult.status === 'fulfilled' ? lastTradeResult.value : null;
    const lastTrade =
      lastTradePayload?.results ??
      lastTradePayload?.lastTrade ??
      lastTradePayload?.trade ??
      lastTradePayload?.data?.results ??
      null;

    debug.endpoints.lastTrade = {
      endpoint: `/v2/last/trade/${ticker}`,
      status: lastTradeResult.status,
      raw: lastTradePayload,
      extractedPath:
        hasValue(lastTradePayload?.results)
          ? 'results'
          : hasValue(lastTradePayload?.lastTrade)
            ? 'lastTrade'
            : hasValue(lastTradePayload?.trade)
              ? 'trade'
              : hasValue(lastTradePayload?.data?.results)
                ? 'data.results'
                : null
    };

    debug.endpoints.snapshot = {
      endpoint: `/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`,
      status: snapshotResult.status,
      raw: snapshotPayload,
      extractedPath:
        hasValue(snapshotPayload?.ticker)
          ? 'ticker'
          : hasValue(snapshotPayload?.results?.ticker)
            ? 'results.ticker'
            : hasValue(snapshotPayload?.results)
              ? 'results'
              : hasValue(snapshotPayload?.data?.ticker)
                ? 'data.ticker'
                : null
    };

    const price = firstNumber(
      [
        { label: 'lastTrade.p', value: lastTrade?.p },
        { label: 'lastTrade.price', value: lastTrade?.price },
        { label: 'snapshot.lastTrade.p', value: snapshot?.lastTrade?.p },
        { label: 'snapshot.lastTrade.price', value: snapshot?.lastTrade?.price },
        { label: 'snapshot.min.c', value: snapshot?.min?.c },
        { label: 'snapshot.day.c', value: snapshot?.day?.c },
        { label: 'snapshot.prevDay.c', value: snapshot?.prevDay?.c },
        { label: 'snapshot.lastQuote.P', value: snapshot?.lastQuote?.P }
      ],
      'price',
      debug.fieldsFound
    );

    const dailyChangePercent = firstNumber(
      [
        { label: 'snapshot.todaysChangePerc', value: snapshot?.todaysChangePerc },
        { label: 'snapshot.day.change_percent', value: snapshot?.day?.change_percent },
        { label: 'snapshot.day.percent_change', value: snapshot?.day?.percent_change },
        { label: 'snapshot.day.pctChange', value: snapshot?.day?.pctChange },
        { label: 'snapshot.session.change_percent', value: snapshot?.session?.change_percent }
      ],
      'dailyChangePercent',
      debug.fieldsFound
    );

    const marketStatus = firstText(
      [
        { label: 'snapshot.market_status', value: snapshot?.market_status },
        { label: 'snapshot.marketStatus', value: snapshot?.marketStatus },
        { label: 'snapshot.session.market_status', value: snapshot?.session?.market_status }
      ],
      'marketStatus',
      debug.fieldsFound
    );

    const tradeTimestamp = firstNumber(
      [
        { label: 'lastTrade.t', value: lastTrade?.t },
        { label: 'lastTrade.timestamp', value: lastTrade?.timestamp },
        { label: 'snapshot.lastTrade.t', value: snapshot?.lastTrade?.t },
        { label: 'snapshot.lastTrade.timestamp', value: snapshot?.lastTrade?.timestamp },
        { label: 'snapshot.min.t', value: snapshot?.min?.t }
      ],
      'updatedAt',
      debug.fieldsFound
    );

    const intraday = intradayResult.status === 'fulfilled' ? intradayResult.value : DEFAULT_INTRADAY;

    debug.selectedSources = {
      price:
        debug.fieldsFound.price && debug.fieldsFound.price.startsWith('lastTrade')
          ? 'last-trade'
          : debug.fieldsFound.price
            ? 'snapshot'
            : null,
      dailyChangePercent: debug.fieldsFound.dailyChangePercent ? 'snapshot' : null,
      marketStatus: debug.fieldsFound.marketStatus ? 'snapshot' : null,
      intraday: intradayResult.status === 'fulfilled' ? 'aggregates' : null
    };

    if (intradayResult.status !== 'fulfilled') {
      debug.endpoints.intraday = {
        endpoint: `/v2/aggs/ticker/${ticker}/range/1/minute/...`,
        status: intradayResult.status,
        error: intradayResult.reason?.message || 'Failed to load aggregates.'
      };
    }

    return NextResponse.json({
      ticker,
      price,
      dailyChangePercent,
      marketStatus,
      source: debug.selectedSources.price ?? (lastTradeResult.status === 'fulfilled' ? 'last-trade' : 'snapshot'),
      updatedAt: tradeTimestamp ? new Date(tradeTimestamp).toISOString() : new Date().toISOString(),
      intraday,
      debug: includeDebug ? debug : undefined
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
