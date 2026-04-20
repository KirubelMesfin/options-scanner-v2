const POLYGON_BASE_URL = 'https://api.polygon.io/v3/reference/options/contracts';

export const dynamic = 'force-dynamic';

async function getOptionsContracts() {
  const apiKey = process.env.POLYGON_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      message: 'POLYGON_API_KEY is not set. Add it in your Vercel project environment variables.',
      results: []
    };
  }

  const url = new URL(POLYGON_BASE_URL);
  url.searchParams.set('limit', '10');
  url.searchParams.set('order', 'asc');
  url.searchParams.set('sort', 'ticker');
  url.searchParams.set('underlying_ticker', 'AAPL');
  url.searchParams.set('apiKey', apiKey);

  try {
    const response = await fetch(url.toString(), {
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        message: `Polygon request failed (${response.status}).`,
        results: []
      };
    }

    const data = await response.json();

    return {
      ok: true,
      message: 'Showing sample AAPL options contracts from Polygon.',
      results: Array.isArray(data.results) ? data.results : []
    };
  } catch (error) {
    return {
      ok: false,
      message: `Unable to fetch Polygon data: ${error.message}`,
      results: []
    };
  }
}

export default async function HomePage() {
  const { ok, message, results } = await getOptionsContracts();

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <h1 style={{ marginBottom: 8 }}>Options Scanner</h1>
      <p style={{ marginTop: 0, color: '#4b5563' }}>
        Minimal Next.js page that reads options contracts server-side using <code>POLYGON_API_KEY</code>.
      </p>

      <div
        style={{
          background: ok ? '#ecfeff' : '#fef2f2',
          border: `1px solid ${ok ? '#a5f3fc' : '#fecaca'}`,
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
          color: '#111827'
        }}
      >
        {message}
      </div>

      {results.length > 0 ? (
        <div style={{ overflowX: 'auto', background: 'white', borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Ticker</th>
                <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Type</th>
                <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Strike</th>
                <th style={{ padding: 10, borderBottom: '1px solid #e5e7eb' }}>Expiration</th>
              </tr>
            </thead>
            <tbody>
              {results.map((contract) => (
                <tr key={contract.ticker}>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.ticker}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.contract_type || 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.strike_price ?? 'N/A'}</td>
                  <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>{contract.expiration_date || 'N/A'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ color: '#6b7280' }}>No contracts to display yet.</p>
      )}
    </main>
  );
}
