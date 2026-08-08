// Serverless NL query — runs on Netlify, key stays server-side.
// Set ANTHROPIC_API_KEY (and optionally FI_MODEL) in Netlify → Site settings → Environment variables.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { answer: 'Ask is not configured: set ANTHROPIC_API_KEY in Netlify env vars.' });

  let q, summary;
  try { ({ q, summary } = JSON.parse(event.body || '{}')); } catch { return json(400, { answer: 'Bad request.' }); }
  if (!q) return json(400, { answer: 'No question.' });

  const system =
    'You are a personal-finance analyst for the Shah family (base currency SGD). ' +
    'Answer ONLY from the JSON data summary provided. Be concise, specific, and practical — ' +
    'lead with the number, then one line of context. If the data does not contain the answer, say so plainly. ' +
    'This is analysis, not licensed financial advice.';

  const body = {
    model: process.env.FI_MODEL || 'claude-opus-4-8',
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: `DATA (SGD):\n${JSON.stringify(summary)}\n\nQUESTION: ${q}` }],
  };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    const answer = d?.content?.[0]?.text || d?.error?.message || 'No answer returned.';
    return json(200, { answer });
  } catch (e) {
    return json(502, { answer: 'Model call failed: ' + (e.message || e) });
  }
};
const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
