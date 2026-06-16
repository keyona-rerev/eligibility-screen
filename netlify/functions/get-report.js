// Netlify Function: GET /api/get-report?t=TOKEN
// Returns one stored Eligibility Quick Screen card by its unguessable token.
// Reads with the service key (RLS stays on, leads table stays private).

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  const token = ((event.queryStringParameters || {}).t || '').trim();
  if (!token || token.length > 80) return json(400, { error: 'Missing or invalid token.' });

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'Not configured.' });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/eligibility_reports?select=report&token=eq.${encodeURIComponent(token)}&limit=1`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length || !rows[0].report) return json(404, { error: 'Report not found.' });
    return json(200, rows[0].report);
  } catch (e) {
    return json(500, { error: 'Could not load the report.' });
  }
};
