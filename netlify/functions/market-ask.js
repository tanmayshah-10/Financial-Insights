// Market-aware analysis: portfolio + live Yahoo quotes → Claude. Keys server-side.
// Requires ANTHROPIC_API_KEY (Netlify env). Optional FI_MODEL.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { answer: 'Method not allowed' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { answer: 'Market Ask is not configured: set ANTHROPIC_API_KEY in Netlify env vars.' });

  let question, positions = [], summary = {};
  try { ({ question, positions = [], summary = {} } = JSON.parse(event.body || '{}')); }
  catch { return json(400, { answer: 'Bad request.' }); }
  if (!question) return json(400, { answer: 'No question.' });

  // fetch live quotes for the positions' Yahoo symbols
  const syms = [...new Set(positions.map((p) => p.ysym).filter(Boolean))];
  const quotes = await fetchQuotes(syms);
  const enriched = positions.map((p) => ({ ...p, quote: quotes[p.ysym] || null }));

  const system =
    'You are a market-aware financial analyst for the Shah family (base currency SGD). ' +
    'Reason over the PORTFOLIO SUMMARY plus the LIVE QUOTES provided. ' +
    'Give analysis and considerations with explicit trade-offs and uncertainty — never a direct "buy/sell X now" instruction. ' +
    'Lead with the specific numbers, cite the prices you used and their date, and flag anything the data does not cover. ' +
    'This is analysis and education, NOT licensed financial advice.';

  const content =
    `PORTFOLIO SUMMARY (SGD):\n${JSON.stringify(summary)}\n\n` +
    `POSITIONS + LIVE QUOTES:\n${JSON.stringify(enriched)}\n\n` +
    `QUESTION: ${question}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.FI_MODEL || 'claude-opus-4-8',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content }],
      }),
    });
    const d = await r.json();
    const answer = d?.content?.[0]?.text || d?.error?.message || 'No answer returned.';
    return json(200, { answer, quotes });
  } catch (e) {
    return json(502, { answer: 'Model call failed: ' + (e.message || e) });
  }
};

async function fetchQuotes(syms) {
  const out = {};
  await Promise.all(syms.slice(0, 60).map(async (s) => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      if (m && m.regularMarketPrice != null) {
        const prev = m.chartPreviousClose ?? m.previousClose;
        out[s] = { price: m.regularMarketPrice, currency: m.currency,
          changePct: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : null,
          asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10) : null };
      }
    } catch {}
  }));
  return out;
}
const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
