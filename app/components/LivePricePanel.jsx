'use client';

import { useEffect, useMemo, useState } from 'react';

function formatCurrency(value) {
  return value == null ? 'N/A' : `$${value.toFixed(2)}`;
}

function formatPercent(value) {
  return value == null ? 'N/A' : `${value.toFixed(2)}%`;
}

function formatTime(iso) {
  if (!iso) return 'N/A';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
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
  const [live, setLive] = useState({
    price: initialPrice ?? null,
    dailyChangePercent: initialDailyChangePercent ?? null,
    source: 'yahoo-finance',
    updatedAt: null,
    intraday: {
      barsCount: 0,
      moveFromOpenPercent: null,
      intradayHigh: null,
      intradayLow: null,
      lastMinuteClose: null
    },
    error: ''
  });

  useEffect(() => {
    let cancelled = false;

    async function loadLive() {
      try {
        const response = await fetch(`/api/live-price?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'Failed to fetch live price.');

        if (!cancelled) {
          setLive((prev) => ({
            ...prev,
            ...data,
            error: ''
          }));
        }
      } catch (error) {
        if (!cancelled) {
          setLive((prev) => ({ ...prev, error: error.message || 'Live price unavailable.' }));
        }
      }
    }

    loadLive();
    const intervalId = setInterval(loadLive, 20000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [ticker]);

  const intradayColor = useMemo(() => {
    const move = live?.intraday?.moveFromOpenPercent;
    if (move == null) return '#111827';
    return move >= 0 ? '#047857' : '#b91c1c';
  }, [live?.intraday?.moveFromOpenPercent]);

  return (
    <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <h2 style={{ marginTop: 0, marginBottom: 10 }}>Live Price Monitor</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <Stat label="Live Price" value={formatCurrency(live.price)} />
        <Stat label="Daily Change" value={formatPercent(live.dailyChangePercent)} color={(live.dailyChangePercent ?? 0) >= 0 ? '#047857' : '#b91c1c'} />
        <Stat label="Intraday Move (1m)" value={formatPercent(live?.intraday?.moveFromOpenPercent)} color={intradayColor} />
        <Stat label="Intraday Range (1m)" value={`${formatCurrency(live?.intraday?.intradayLow)} - ${formatCurrency(live?.intraday?.intradayHigh)}`} />
        <Stat label="1m Bars Fetched" value={live?.intraday?.barsCount ?? 0} />
        <Stat label="Last 1m Close" value={formatCurrency(live?.intraday?.lastMinuteClose)} />
        <Stat label="Feed Source" value={live.source === 'yahoo-finance' ? 'Yahoo Finance' : live.source ?? 'N/A'} />
        <Stat label="Last Updated" value={formatTime(live.updatedAt)} />
      </div>
      {live.error ? <p style={{ color: '#b91c1c', marginBottom: 0 }}>Live updates temporarily unavailable: {live.error}</p> : null}
    </section>
  );
}
