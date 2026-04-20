const API_BASE = 'https://api.polygon.io';

export const dynamic = 'force-dynamic';

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

function getDaysToExpiration(expirationDate) {
  if (!expirationDate) return null;
  const now = new Date();
  const exp = new Date(`${expirationDate}T00:00:00Z`);
  return Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
}

function buildReasoning(contract, stockPrice) {
  const reasons = [];
  const spread = contract.ask != null && contract.bid != null ? contract.ask - contract.bid : null;
  const spreadPct = spread != null && contract.midpoint > 0 ? spread / contract.midpoint : null;

  if ((contract.volume ?? 0) >= 500) reasons.push('strong trading volume');
  else if ((contract.volume ?? 0) >= 100) reasons.push('healthy volume');

  if ((contract.openInterest ?? 0) >= 1000) reasons.push('deep open interest');
  else if ((contract.openInterest ?? 0) >= 200) reasons.push('solid open interest');

  if (spreadPct != null && spreadPct <= 0.1) reasons.push('tight bid-ask spread');

  if (contract.impliedVolatility != null && contract.impliedVolatility >= 0.15 && contract.impliedVolatility <= 0.7) {
    reasons.push('reasonable implied volatility');
  }

  if (stockPrice != null && contract.strike != null) {
    const strikeDistancePct = Math.abs(contract.strike - stockPrice) / stockPrice;
    if (strikeDistancePct <= 0.05) reasons.push('strike is close to spot price');
  }

  return reasons.length > 0
    ? `Ranked highly due to ${reasons.slice(0, 3).join(', ')}.`
    : 'Ranked on balanced liquidity, pricing, and strike placement.';
}

function scoreContract(contract, stockPrice) {
  const volume = contract.volume ?? 0;
  const openInterest = contract.openInterest ?? 0;
  const spread = contract.ask != null && contract.bid != null ? Math.max(contract.ask - contract.bid, 0) : null;
  const mid = contract.midpoint;
  const spreadPct = spread != null && mid > 0 ? spread / mid : null;
  const iv = contract.impliedVolatility;

  const volumeScore = Math.min(volume / 2000, 1) * 25;
  const oiScore = Math.min(openInterest / 5000, 1) * 25;
  const spreadScore = spreadPct == null ? 0 : Math.max(0, 1 - spreadPct / 0.4) * 20;

  let ivScore = 0;
  if (iv != null) {
    const distanceFromIdeal = Math.abs(iv - 0.35);
    ivScore = Math.max(0, 1 - distanceFromIdeal / 0.35) * 15;
  }

  let strikeProximityScore = 0;
  if (stockPrice != null && contract.strike != null) {
    const strikeDistancePct = Math.abs(contract.strike - stockPrice) / stockPrice;
    strikeProximityScore = Math.max(0, 1 - strikeDistancePct / 0.15) * 15;
  }

  return volumeScore + oiScore + spreadScore + ivScore + strikeProximityScore;
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

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Polygon request failed (${response.status})`);
  }
  return response.json();
}

async function getStockContext(ticker, apiKey) {
  const snapshotUrl = `${API_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`;
  const detailsUrl = `${API_BASE}/v3/reference/tickers/${ticker}?apiKey=${apiKey}`;

  const [snapshotResult, detailsResult] = await Promise.allSettled([fetchJson(snapshotUrl), fetchJson(detailsUrl)]);

  const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value?.ticker : null;
  const details = detailsResult.status === 'fulfilled' ? detailsResult.value?.results : null;

  const price =
    toNumber(snapshot?.lastTrade?.p) ??
    toNumber(snapshot?.lastQuote?.P) ??
    toNumber(snapshot?.day?.c) ??
    toNumber(snapshot?.prevDay?.c);

  return {
    price,
    dailyChangePercent: toNumber(snapshot?.todaysChangePerc),
    marketCap: toNumber(details?.market_cap),
    companyName: details?.name ?? ticker
  };
}

async function getOptionsChain(ticker, apiKey) {
  let nextUrl = `${API_BASE}/v3/snapshot/options/${ticker}?limit=250&apiKey=${apiKey}`;
  const results = [];
  let safetyCounter = 0;

  while (nextUrl && safetyCounter < 4) {
    // limit pagination to keep server response time reasonable
    const data = await fetchJson(nextUrl);
    if (Array.isArray(data?.results)) {
      results.push(...data.results);
    }
    nextUrl = data?.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
    safetyCounter += 1;
  }

  return results.map(normalizeContract);
}

function parseFilters(searchParams, stockPrice) {
  const optionType = searchParams?.optionType ?? 'all';
  const expirationFrom = searchParams?.expirationFrom || '';
  const expirationTo = searchParams?.expirationTo || '';
  const minVolume = Math.max(0, Number(searchParams?.minVolume ?? 0) || 0);
  const minOpenInterest = Math.max(0, Number(searchParams?.minOpenInterest ?? 0) || 0);
  const maxSpread = Math.max(0, Number(searchParams?.maxSpread ?? 10) || 10);
  const nearMoneyOnly = searchParams?.nearMoneyOnly === 'on';
  const nearMoneyThresholdPct = 0.05;

  return {
    optionType,
    expirationFrom,
    expirationTo,
    minVolume,
    minOpenInterest,
    maxSpread,
    nearMoneyOnly,
    nearMoneyThresholdPct,
    stockPrice
  };
}

function applyFilters(contracts, filters) {
  return contracts.filter((contract) => {
    if (filters.optionType !== 'all' && contract.contractType !== filters.optionType) return false;

    if (filters.expirationFrom && contract.expiration && contract.expiration < filters.expirationFrom) return false;
    if (filters.expirationTo && contract.expiration && contract.expiration > filters.expirationTo) return false;

    if ((contract.volume ?? 0) < filters.minVolume) return false;
    if ((contract.openInterest ?? 0) < filters.minOpenInterest) return false;

    const spread = contract.ask != null && contract.bid != null ? contract.ask - contract.bid : null;
    if (spread != null && spread > filters.maxSpread) return false;

    if (filters.nearMoneyOnly && filters.stockPrice != null && contract.strike != null) {
      const strikeDistancePct = Math.abs(contract.strike - filters.stockPrice) / filters.stockPrice;
      if (strikeDistancePct > filters.nearMoneyThresholdPct) return false;
    }

    return true;
  });
}

function findBestCalls(contracts, stockPrice) {
  const calls = contracts.filter((c) => c.contractType === 'call');
  const scored = calls.map((contract) => ({ ...contract, score: scoreContract(contract, stockPrice) }));

  const inRangeBest = (minDays, maxDays) =>
    scored
      .filter((c) => {
        const dte = getDaysToExpiration(c.expiration);
        return dte != null && dte >= minDays && dte <= maxDays;
      })
      .sort((a, b) => b.score - a.score)[0] ?? null;

  const bestOneMonth = inRangeBest(20, 45);
  const bestTwoMonth = inRangeBest(46, 75);

  return {
    bestOneMonth: bestOneMonth
      ? { ...bestOneMonth, reasoning: buildReasoning(bestOneMonth, stockPrice), score: bestOneMonth.score.toFixed(1) }
      : null,
    bestTwoMonth: bestTwoMonth
      ? { ...bestTwoMonth, reasoning: buildReasoning(bestTwoMonth, stockPrice), score: bestTwoMonth.score.toFixed(1) }
      : null
  };
}

function SuggestionCard({ title, contract }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, flex: 1, minWidth: 260 }}>
      <h3 style={{ marginTop: 0, marginBottom: 10 }}>{title}</h3>
      {contract ? (
        <>
          <p style={{ margin: '0 0 8px 0', fontWeight: 700 }}>{contract.ticker}</p>
          <p style={{ margin: '0 0 8px 0', color: '#374151' }}>
            Strike {formatCurrency(contract.strike)} · Exp {contract.expiration} · Score {contract.score}
          </p>
          <p style={{ margin: '0 0 8px 0', color: '#374151' }}>
            Bid/Ask {formatCurrency(contract.bid)} / {formatCurrency(contract.ask)} · IV{' '}
            {contract.impliedVolatility != null ? contract.impliedVolatility.toFixed(2) : 'N/A'}
          </p>
          <p style={{ margin: 0, color: '#4b5563' }}>{contract.reasoning}</p>
        </>
      ) : (
        <p style={{ margin: 0, color: '#6b7280' }}>No contract met the scoring criteria for this expiration window.</p>
      )}
    </div>
  );
}

export default async function HomePage({ searchParams }) {
  const apiKey = process.env.POLYGON_API_KEY;
  const ticker = (searchParams?.ticker || 'AAPL').trim().toUpperCase();

  if (!apiKey) {
    return (
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
        <h1>Options Scanner</h1>
        <p style={{ color: '#b91c1c' }}>
          POLYGON_API_KEY is not set. Add it to your environment variables before using the scanner.
        </p>
      </main>
    );
  }

  let contracts = [];
  let stock = { price: null, dailyChangePercent: null, marketCap: null, companyName: ticker };
  let errorMessage = '';

  try {
    [contracts, stock] = await Promise.all([getOptionsChain(ticker, apiKey), getStockContext(ticker, apiKey)]);
  } catch (error) {
    errorMessage = error.message || 'Failed to load scanner data.';
  }

  const filters = parseFilters(searchParams, stock.price);
  const filteredContracts = applyFilters(contracts, filters);
  const suggestions = findBestCalls(filteredContracts, stock.price);

  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 24 }}>
      <h1 style={{ marginBottom: 6 }}>Options Scanner</h1>
      <p style={{ marginTop: 0, color: '#4b5563' }}>Search ticker symbols and scan options by liquidity, pricing, and proximity.</p>

      <form method="GET" style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', marginBottom: 16 }}>
        <div style={{ gridColumn: 'span 3' }}>
          <label htmlFor="ticker" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            Ticker
          </label>
          <input id="ticker" name="ticker" defaultValue={ticker} placeholder="AAPL" style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #d1d5db' }} />
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label htmlFor="optionType" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            Type
          </label>
          <select id="optionType" name="optionType" defaultValue={filters.optionType} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #d1d5db' }}>
            <option value="all">Calls + Puts</option>
            <option value="call">Calls only</option>
            <option value="put">Puts only</option>
          </select>
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label htmlFor="expirationFrom" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            Expiration from
          </label>
          <input type="date" id="expirationFrom" name="expirationFrom" defaultValue={filters.expirationFrom} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #d1d5db' }} />
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label htmlFor="expirationTo" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            Expiration to
          </label>
          <input type="date" id="expirationTo" name="expirationTo" defaultValue={filters.expirationTo} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #d1d5db' }} />
        </div>
        <div style={{ gridColumn: 'span 1' }}>
          <label htmlFor="minVolume" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            Min vol
          </label>
          <input type="number" id="minVolume" name="minVolume" min="0" defaultValue={filters.minVolume} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #d1d5db' }} />
        </div>
        <div style={{ gridColumn: 'span 1' }}>
          <label htmlFor="minOpenInterest" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            Min OI
          </label>
          <input type="number" id="minOpenInterest" name="minOpenInterest" min="0" defaultValue={filters.minOpenInterest} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #d1d5db' }} />
        </div>
        <div style={{ gridColumn: 'span 1' }}>
          <label htmlFor="maxSpread" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            Max spread
          </label>
          <input type="number" id="maxSpread" name="maxSpread" min="0" step="0.01" defaultValue={filters.maxSpread} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #d1d5db' }} />
        </div>
        <div style={{ gridColumn: 'span 2', display: 'flex', alignItems: 'end', gap: 12 }}>
          <label htmlFor="nearMoneyOnly" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" id="nearMoneyOnly" name="nearMoneyOnly" defaultChecked={filters.nearMoneyOnly} />
            Near-the-money only
          </label>
          <button type="submit" style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: '#111827', color: '#fff', cursor: 'pointer' }}>
            Scan
          </button>
        </div>
      </form>

      {errorMessage ? (
        <div style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 10, padding: 12, marginBottom: 16 }}>
          {errorMessage}
        </div>
      ) : null}

      <section style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, minWidth: 220 }}>
          <div style={{ color: '#6b7280', marginBottom: 8 }}>Current Price</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{formatCurrency(stock.price)}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, minWidth: 220 }}>
          <div style={{ color: '#6b7280', marginBottom: 8 }}>Daily Change</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: (stock.dailyChangePercent ?? 0) >= 0 ? '#047857' : '#b91c1c' }}>
            {formatPercent(stock.dailyChangePercent)}
          </div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, minWidth: 220 }}>
          <div style={{ color: '#6b7280', marginBottom: 8 }}>Market Cap</div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{formatCompactNumber(stock.marketCap)}</div>
        </div>
      </section>

      <section style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <SuggestionCard title="Best 1-Month Call" contract={suggestions.bestOneMonth} />
        <SuggestionCard title="Best 2-Month Call" contract={suggestions.bestTwoMonth} />
      </section>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', background: '#f9fafb' }}>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Contract</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Type</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Strike</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Expiration</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Bid</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Ask</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Last</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Volume</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Open Interest</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>IV</th>
              <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Delta</th>
            </tr>
          </thead>
          <tbody>
            {filteredContracts.length > 0 ? (
              filteredContracts.map((contract) => (
                <tr key={contract.ticker}>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6', fontFamily: 'monospace', fontSize: 12 }}>{contract.ticker}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.contractType}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{formatCurrency(contract.strike)}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.expiration ?? 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{formatCurrency(contract.bid)}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{formatCurrency(contract.ask)}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{formatCurrency(contract.lastPrice)}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.volume ?? 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.openInterest ?? 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>
                    {contract.impliedVolatility != null ? contract.impliedVolatility.toFixed(3) : 'N/A'}
                  </td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.delta != null ? contract.delta.toFixed(3) : 'N/A'}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={11} style={{ padding: 14, color: '#6b7280' }}>
                  No contracts matched the selected filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
