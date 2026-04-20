import { NextResponse } from 'next/server';

const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DEFAULT_INTRADAY = {
  interval: '1m',
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
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; options-scanner-v2/1.0)'
    }
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    const error = new Error(`Yahoo Finance request failed (${response.status})`);
    error.status = response.status;
    error.details = details;
    throw error;
  }

  return response.json();
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

function extractIntradayFromChart(data, interval) {
  const result = data?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0] ?? {};

  const opens = Array.isArray(quote.open) ? quote.open.map(toNumber).filter((v) => v != null) : [];
  const closes = Array.isArray(quote.close) ? quote.close.map(toNumber).filter((v) => v != null) : [];
  const highs = Array.isArray(quote.high) ? quote.high.map(toNumber).filter((v) => v != null) : [];
  const lows = Array.isArray(quote.low) ? quote.low.map(toNumber).filter((v) => v != null) : [];

  if (!closes.length) return DEFAULT_INTRADAY;

  const open = opens[0] ?? closes[0] ?? null;
  const lastClose = closes.at(-1) ?? null;

  return {
    interval,
    barsCount: closes.length,
    moveFromOpenPercent: open && lastClose ? ((lastClose - open) / open) * 100 : null,
    intradayHigh: highs.length ? Math.max(...highs) : null,
    intradayLow: lows.length ? Math.min(...lows) : null,
    lastMinuteClose: lastClose
  };
}

async function getIntradayContext(ticker, debug) {
  const intervals = ['1m', '5m'];

  for (const interval of intervals) {
    const url = `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?interval=${interval}&range=1d&includePrePost=true&events=div,splits`;

    try {
      const data = await fetchJson(url);
      const errorDescription = data?.chart?.error?.description;
      if (errorDescription) {
        debug.intradayAttempts.push({ interval, endpoint: '/v8/finance/chart/:ticker', error: errorDescription });
        continue;
      }

      const intraday = extractIntradayFromChart(data, interval);
      debug.intradayAttempts.push({ interval, endpoint: '/v8/finance/chart/:ticker', barsCount: intraday.barsCount });
      if (intraday.barsCount > 0) return intraday;
    } catch (error) {
      debug.intradayAttempts.push({ interval, endpoint: '/v8/finance/chart/:ticker', error: error.message });
    }
  }

  return DEFAULT_INTRADAY;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get('ticker') || 'AAPL').trim().toUpperCase();
  const includeDebug = searchParams.get('debug') !== '0';

  try {
    const debug = {
      requestedTicker: ticker,
      endpoints: {},
      selectedSources: {},
      fieldsFound: {},
      intradayAttempts: []
    };

    const quoteUrl = `${YAHOO_QUOTE_URL}?symbols=${encodeURIComponent(ticker)}`;
    const [quoteResult, intraday] = await Promise.all([fetchJson(quoteUrl), getIntradayContext(ticker, debug)]);
    const quote = quoteResult?.quoteResponse?.result?.[0] ?? null;

    debug.endpoints.quote = {
      endpoint: '/v7/finance/quote',
      foundQuote: Boolean(quote),
      raw: quoteResult
    };

    if (!quote) {
      return NextResponse.json({ error: `No Yahoo Finance quote found for ticker ${ticker}.` }, { status: 404 });
    }

    const price = firstNumber(
      [
        { label: 'quote.regularMarketPrice', value: quote?.regularMarketPrice },
        { label: 'quote.postMarketPrice', value: quote?.postMarketPrice },
        { label: 'quote.preMarketPrice', value: quote?.preMarketPrice },
        { label: 'quote.bid', value: quote?.bid }
      ],
      'price',
      debug.fieldsFound
    );

    const dailyChangePercent = firstNumber(
      [
        { label: 'quote.regularMarketChangePercent', value: quote?.regularMarketChangePercent },
        { label: 'quote.postMarketChangePercent', value: quote?.postMarketChangePercent },
        { label: 'quote.preMarketChangePercent', value: quote?.preMarketChangePercent }
      ],
      'dailyChangePercent',
      debug.fieldsFound
    );

    const marketStatus = firstText(
      [
        { label: 'quote.marketState', value: quote?.marketState },
        { label: 'quote.exchange', value: quote?.exchange }
      ],
      'marketStatus',
      debug.fieldsFound
    );

    const updatedAtSeconds = firstNumber(
      [
        { label: 'quote.regularMarketTime', value: quote?.regularMarketTime },
        { label: 'quote.postMarketTime', value: quote?.postMarketTime },
        { label: 'quote.preMarketTime', value: quote?.preMarketTime }
      ],
      'updatedAt',
      debug.fieldsFound
    );

    debug.selectedSources = {
      price: debug.fieldsFound.price ? 'yahoo-quote' : null,
      dailyChangePercent: debug.fieldsFound.dailyChangePercent ? 'yahoo-quote' : null,
      marketStatus: debug.fieldsFound.marketStatus ? 'yahoo-quote' : null,
      intraday: intraday.barsCount ? `yahoo-chart-${intraday.interval}` : null
    };

    return NextResponse.json({
      ticker,
      price,
      dailyChangePercent,
      marketStatus,
      source: 'yahoo-finance',
      updatedAt: updatedAtSeconds ? new Date(updatedAtSeconds * 1000).toISOString() : new Date().toISOString(),
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
