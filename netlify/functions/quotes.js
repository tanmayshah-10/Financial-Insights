// Live quotes from Yahoo Finance (no API key). Server-side to avoid browser CORS.
// POST { symbols:["NVDA","SUNPHARMA.NS","ETH-USD"] }  or  GET ?symbols=NVDA,ETH-USD
exports.handler = async (event) => {
  let symbols = [];
  try { symbols = JSON.parse(event.body || '{}').symbols || []; } catch {}
  if (event.httpMethod === 'GET' && event.queryStringParameters?.symbols)
    symbols = event.queryStringParameters.symbols.split(',');
  symbols = [...new Set(symbols.filter(Boolean))].slice(0, 60);

  const quotes = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const d = await r.json();
      const m = d?.chart?.result?.[0]?.meta;
      if (m && m.regularMarketPrice != null) {
        const prev = m.chartPreviousClose ?? m.previousClose;
        quotes[s] = {
          price: m.regularMarketPrice,
          currency: m.currency,
          changePct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : null,
          asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10) : null,
        };
      } else { quotes[s] = { error: 'no data' }; }
    } catch (e) { quotes[s] = { error: String(e.message || e) }; }
  }));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quotes }) };
};
