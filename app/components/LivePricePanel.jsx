'use client';

import { useEffect, useState } from 'react';

function formatCurrency(value) {
  return value == null ? 'N/A' : `$${value.toFixed(2)}`;
}

function formatPercent(value) {
  return value == null ? 'N/A' : `${value.toFixed(2)}%`;
}

function formatTime(iso) {
  if (!iso) return 'N/A';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function Stat({ label, value, color }) {
  return (
    <div style={{ border: '1px solid #f3f4f6', borderRadius: 10, padding: 10 }}>
      <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: color ?? '#111827' }}>{value}</div>
    </div>
  );
}

export default function LivePricePanel({ ticker, initialPrice, initialDailyChangePercent }) {
  const [quote, setQuote] = useState({
    price: initialPrice ?? null,
    dailyChangePercent: initialDailyChangePercent ?? null,
    sourceLabel: 'Delayed daily stock data',
    freshnessLabel: 'Delayed / last close',
    updatedAt: null,
    warning: ''
  });

  useEffect(() => {
    let cancelled = false;

    async function loadDelayedQuote() {
      try {
        const response = await fetch(`/api/live-price?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store' });
        const data = await response.json();

        if (!cancelled) {
          setQuote((prev) => ({
            ...prev,
            ...data,
            price: data?.price ?? prev.price,
            dailyChangePercent: data?.dailyChangePercent ?? prev.dailyChangePercent
          }));
        }
      } catch (_error) {
        if (!cancelled) {
          setQuote((prev) => ({
            ...prev,
            warning: prev.warning || 'Unable to refresh delayed quote. Retaining latest known values.'
          }));
        }
      }
    }

    loadDelayedQuote();
    const intervalId = setInterval(loadDelayedQuote, 60000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [ticker]);

  return (
    <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <h2 style={{ marginTop: 0, marginBottom: 10 }}>Stock Price Snapshot</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <Stat label="Price" value={formatCurrency(quote.price)} />
        <Stat label="Daily Change" value={formatPercent(quote.dailyChangePercent)} color={(quote.dailyChangePercent ?? 0) >= 0 ? '#047857' : '#b91c1c'} />
        <Stat label="Source" value={quote.sourceLabel ?? 'Delayed daily stock data'} />
        <Stat label="Freshness" value={quote.freshnessLabel ?? 'Delayed / last close'} />
        <Stat label="Data Timestamp" value={formatTime(quote.updatedAt)} />
      </div>
      {quote.warning ? <p style={{ color: '#92400e', marginBottom: 0 }}>Note: {quote.warning}</p> : null}
    </section>
  );
}
