// Netlify Function: POST /api/report
// Eligibility Quick Screen (T033) — a ReRev Labs / Athlete Site Pixie.
// DETERMINISTIC NCAA initial-eligibility rules engine (sourced live June 2026 from the
// NCAA Eligibility Center / NCAA.org: 16 core courses, DI 2.3 / DII 2.2 core-GPA floors,
// DI 10/7 progression + locked grades, qualifier tiers, test-optional status). Gives
// RISK FLAGS, not an official determination — every result points to the Eligibility
// Center. Haiku (temp 0, no web search) writes ONLY the plain-language reads; templated
// fallback so it never hard-fails.
// Guards mirror T030: validate -> Turnstile -> daily cap -> per-IP -> 30d cache
//   -> compute -> narrative -> save (+token) -> email parent + notify internally.

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

const stripTags = (s) => String(s == null ? '' : s)
  .replace(/<\/?cite[^>]*>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// ---------- division rules ----------
const RULES = {
  DI: {
    label: 'Division I',
    coreTotal: 16,
    gpaFull: 2.3,
    gpaRedshirt: 2.0,
    midTier: 'Academic Redshirt',
    breakdown: '4 English, 3 Math (Algebra I+), 2 Natural/Physical Science, 1 extra (Eng/Math/Sci), 2 Social Science, 4 additional',
    timing: 'Complete 10 of 16 core courses before the start of your 7th semester (senior year); 7 of those 10 in English, Math, or Science. Those grades then LOCK and cannot be retaken to raise the GPA.',
    lockGrade: 12,        // 10 of 16 due before senior year
    lockCount: 10,
  },
  DII: {
    label: 'Division II',
    coreTotal: 16,
    gpaFull: 2.2,
    gpaRedshirt: 2.0,
    midTier: 'Partial Qualifier',
    breakdown: '3 English, 2 Math (Algebra I+), 2 Natural/Physical Science, 3 extra (Eng/Math/Sci), 2 Social Science, 4 additional',
    timing: 'No 10-of-16 lock-in rule. Earn all 16 core courses and a 2.2 core GPA, and submit a final transcript with proof of graduation.',
    lockGrade: null,
    lockCount: null,
  },
};

const GRADE_NAME = { 9: 'freshman', 10: 'sophomore', 11: 'junior', 12: 'senior' };
// expected core courses completed "by now" for pace flagging, keyed to entering grade
const EXPECTED_BY = { 9: 0, 10: 4, 11: 8, 12: 10, 13: 16 };

function computeEntering(gradYear, now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const springYear = m >= 7 ? y + 1 : y;
  const completed = 12 - (gradYear - springYear);
  return Math.min(13, completed + 1);
}

function buildBase(division, coreDone, coreGpa, gradYear, now) {
  const R = RULES[division];
  const entering = computeEntering(gradYear, now);
  const graduated = entering > 12;
  const expected = EXPECTED_BY[Math.min(13, Math.max(9, entering))];

  // GPA status
  let gpaStatus, gpaNote;
  if (coreGpa >= R.gpaFull) { gpaStatus = 'ok'; gpaNote = 'meets the ' + R.gpaFull.toFixed(1) + ' core-GPA floor for a full qualifier'; }
  else if (coreGpa >= R.gpaRedshirt) { gpaStatus = 'risk'; gpaNote = 'below the ' + R.gpaFull.toFixed(1) + ' full-qualifier floor but above ' + R.gpaRedshirt.toFixed(1) + ' — ' + R.midTier + ' territory'; }
  else { gpaStatus = 'off'; gpaNote = 'below ' + R.gpaRedshirt.toFixed(1) + ', the nonqualifier line'; }

  // core pace status
  let paceStatus, paceNote;
  if (coreDone >= R.coreTotal) { paceStatus = 'ok'; paceNote = 'all ' + R.coreTotal + ' core courses done'; }
  else if (coreDone >= expected) { paceStatus = 'ok'; paceNote = coreDone + ' of ' + R.coreTotal + ' done — on pace for your grade'; }
  else { paceStatus = 'risk'; paceNote = coreDone + ' of ' + R.coreTotal + ' done — behind the ~' + expected + ' expected by now'; }

  // DI 10/7 timing flag
  let timingStatus = 'ok', timingNote = '';
  if (division === 'DI') {
    if (entering >= 12 && coreDone < R.lockCount) { timingStatus = 'off'; timingNote = 'DI requires 10 of 16 core courses locked before senior year; you report ' + coreDone + '. This is the highest-risk flag.'; }
    else if (entering === 11 && coreDone < 8) { timingStatus = 'risk'; timingNote = 'You will need 10 of 16 (7 in Eng/Math/Sci) by the end of junior year; at ' + coreDone + ' now, the pace is tight.'; }
    else { timingNote = 'On pace for the 10-of-16-before-senior-year rule.'; }
  }

  // overall verdict (worst of the three)
  const rank = { ok: 0, risk: 1, off: 2 };
  const worst = Math.max(rank[gpaStatus], rank[paceStatus], rank[timingStatus]);
  let hero, verdict;
  if (worst === 0) { hero = 'On Track'; verdict = 'Tracking toward a full ' + R.label + ' qualifier'; }
  else if (worst === 1) { hero = 'At Risk'; verdict = 'Some flags to clear for ' + R.label; }
  else { hero = 'Off Track'; verdict = 'Serious ' + R.label + ' eligibility risk'; }

  const heroSub = R.label + ' · core GPA ' + coreGpa.toFixed(2) + ' · ' + coreDone + '/' + R.coreTotal + ' core';

  const mk = (st) => st === 'ok' ? '✓' : (st === 'risk' ? '⚠' : '✕');
  const rows = [
    { label: 'Core courses', value: mk(paceStatus) + ' ' + paceNote, accent: paceStatus !== 'ok' },
    { label: 'Core GPA', value: mk(gpaStatus) + ' ' + coreGpa.toFixed(2) + ' — ' + gpaNote, accent: gpaStatus !== 'ok' },
  ];
  if (division === 'DI') rows.push({ label: '10-of-16 timing', value: mk(timingStatus) + ' ' + (timingNote || 'On pace.'), accent: timingStatus !== 'ok' });
  rows.push({ label: 'Required breakdown', value: R.breakdown, accent: false });
  rows.push({ label: 'Standardized tests', value: 'Not required for NCAA initial eligibility; some colleges still want them for admission', accent: false });
  rows.push({ label: 'Next step', value: 'Register and confirm status at the NCAA Eligibility Center (eligibilitycenter.org)', accent: true });

  const first_read = 'This is a risk screen for ' + R.label + ', not an official ruling. With a ' + coreGpa.toFixed(2) + ' core GPA and ' + coreDone + ' of ' + R.coreTotal + ' core courses, you are ' + hero + '. The NCAA Eligibility Center makes the only official determination.';

  return { R, division, entering, graduated, coreDone, coreGpa, gradYear, gpaStatus, gpaNote, paceStatus, paceNote, timingStatus, timingNote, hero, verdict, heroSub, rows, first_read };
}

function templatedReads(b) {
  return {
    flags: 'Here is the plain version: your core GPA ' + b.coreGpa.toFixed(2) + ' is ' + b.gpaNote + ', and your core courses are ' + b.paceNote + '.' + (b.division === 'DI' && b.timingNote ? ' On timing: ' + b.timingNote : ''),
    fix: b.hero === 'On Track'
      ? 'Keep doing what you are doing: protect that GPA, finish the remaining core courses on time, and do not let a senior-year slip undo it.'
      : 'The move now is to meet your counselor this week, map the exact core courses left, and protect every core grade from here — especially in English, math, and science.',
    official: 'This tool only flags risk. The NCAA Eligibility Center is the only place that certifies eligibility, so register there, send your transcripts, and let them confirm your status. Nothing here is a guarantee.',
  };
}

async function aiReads(b, key) {
  const prompt =
`You are writing three short, honest, plain-language paragraphs for a parent using an NCAA eligibility RISK screen. This is NOT an official determination and you must say so. Use ONLY the facts below. Do not invent rules or numbers. Warm, plain, direct. No markdown, no lists, no headers, no em dashes.

FACTS
- Division target: ${b.R.label}.
- Core GPA: ${b.coreGpa.toFixed(2)} (full-qualifier floor is ${b.R.gpaFull.toFixed(1)}; ${b.R.midTier} possible above ${b.R.gpaRedshirt.toFixed(1)}; nonqualifier below ${b.R.gpaRedshirt.toFixed(1)}).
- Core courses: ${b.coreDone} of ${b.R.coreTotal} done. ${b.paceNote}.
- ${b.division === 'DI' ? 'DI 10-of-16 timing: ' + (b.timingNote || 'on pace') + '.' : 'DII has no 10-of-16 lock-in rule.'}
- Overall risk read: ${b.hero}.
- Standardized tests are NOT required for NCAA initial eligibility, though colleges may want them for admission.
- The NCAA Eligibility Center is the ONLY official determiner of eligibility.

Return ONLY a JSON object, no fences and no preamble, exactly:
{"flags":"2-3 sentences explaining the flags in plain terms","fix":"2-3 sentences on the concrete next steps","official":"2-3 sentences making clear this is risk-only and pointing to the NCAA Eligibility Center"}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 700, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok || data.error) return null;
    const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    if (!o.flags || !o.fix || !o.official) return null;
    return { flags: stripTags(o.flags), fix: stripTags(o.fix), official: stripTags(o.official) };
  } catch (e) { return null; }
}

async function emailParent({ to, firstName, clean, shareUrl, key, from, replyTo }) {
  const html =
`<div style="font-family:Arial,Helvetica,sans-serif;background:#0A0A0A;color:#FFFFFF;padding:32px;border-radius:4px;max-width:520px;margin:0 auto;border:1px solid #2A2A2A">
  <div style="font-family:monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6f6f6f">Athlete Site / Eligibility Quick Screen</div>
  <h1 style="font-size:22px;font-weight:800;margin:14px 0 6px;letter-spacing:-.02em">${firstName}, here is your eligibility risk read.</h1>
  <p style="font-size:15px;line-height:1.5;color:#B8B8B8;margin:0 0 18px">Risk flags only, not an official determination. The NCAA Eligibility Center makes the official call.</p>
  <div style="border-left:3px solid #FF4D00;padding-left:14px;margin:0 0 22px">
    <div style="font-size:20px;font-weight:700">${clean.hero}</div>
    <div style="font-size:14px;color:#B8B8B8;margin-top:6px;line-height:1.5">${clean.first_read}</div>
  </div>
  <a href="${shareUrl}" style="display:inline-block;background:#FF4D00;color:#0A0A0A;text-decoration:none;font-family:monospace;font-weight:600;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:13px 24px;border-radius:2px">View your full screen &rarr;</a>
  <p style="font-size:12px;color:#6f6f6f;margin:26px 0 0;line-height:1.5">This is not an eligibility guarantee. Register and confirm at eligibilitycenter.org. You can download your card from the link above.</p>
</div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject: `${firstName}, your NCAA eligibility risk read`, html }),
  });
}

async function notifyInternal({ lead, clean, shareUrl, key, from, notifyTo }) {
  const subject = `[T033 · Eligibility Screen] New lead - ${lead.full_name}, ${clean.division} (${clean.hero})`;
  const html =
`<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.6">
  <p><b>New Eligibility Quick Screen lead.</b></p>
  <p>Name: ${lead.full_name}<br>Email: ${lead.email}<br>Division: ${clean.division}<br>Core GPA: ${lead.core_gpa}<br>Core done: ${lead.core_done}/16<br>Grad year: ${lead.grad_year}</p>
  <p>Risk read: ${clean.hero} — ${clean.verdict}</p>
  <p><a href="${shareUrl}">View their card</a></p>
</div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [notifyTo], subject, html }),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Bad request.' }); }

  const fullName = String(body.full_name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const division = String(body.division || '').trim().toUpperCase();
  const coreDone = Math.max(0, Math.min(16, parseInt(body.core_done, 10)));
  const coreGpa = Math.max(0, Math.min(4.5, parseFloat(body.core_gpa)));
  const gradYear = parseInt(body.grad_year, 10);
  const token = String(body.turnstile_token || '');

  if (!fullName || fullName.length > 80) return json(400, { error: 'Please enter the parent or athlete name.' });
  if (email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Please enter a valid email.' });
  if (!RULES[division]) return json(400, { error: 'Please pick a division target (DI or DII).' });
  if (!(coreDone >= 0 && coreDone <= 16)) return json(400, { error: 'Core courses completed must be between 0 and 16.' });
  if (!(coreGpa >= 0 && coreGpa <= 4.5)) return json(400, { error: 'Please enter a core GPA between 0 and 4.5.' });
  if (!(gradYear >= 2024 && gradYear <= 2035)) return json(400, { error: 'Please enter a graduation year between 2024 and 2035.' });

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, TURNSTILE_SECRET, DAILY_CAP, RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, LEAD_NOTIFY_TO } = process.env;
  const cap = parseInt(DAILY_CAP || '200', 10);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'The tool is not fully configured yet.' });

  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const base = 'https://' + (event.headers.host || 'eligibility-screen.netlify.app');

  if (TURNSTILE_SECRET) {
    try {
      const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
      if (ip) form.append('remoteip', ip);
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
      const j = await r.json();
      if (!j.success) return json(403, { error: 'Could not verify you are human. Please try again.' });
    } catch { return json(403, { error: 'Could not verify you are human. Please try again.' }); }
  }

  const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const countOf = (res) => parseInt((res.headers.get('content-range') || '*/0').split('/')[1] || '0', 10);

  try {
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    const r = await sb(`eligibility_reports?select=id&created_at=gte.${startOfDay.toISOString()}`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
    if (countOf(r) >= cap) return json(429, { error: "We're at capacity for today. Check back tomorrow." });
  } catch (e) {}

  if (ip) {
    try {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const r = await sb(`eligibility_reports?select=id&ip=eq.${encodeURIComponent(ip)}&created_at=gte.${since}`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
      if (countOf(r) >= 4) return json(429, { error: "You've run a few already. Give it a minute." });
    } catch (e) {}
  }

  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const r = await sb(`eligibility_reports?select=report,token&email=eq.${encodeURIComponent(email)}&division=eq.${encodeURIComponent(division)}&core_gpa=eq.${coreGpa}&created_at=gte.${since}&order=created_at.desc&limit=1`);
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length && rows[0].report) {
      return json(200, { ...rows[0].report, token: rows[0].token || null, share_path: rows[0].token ? `/report.html?t=${rows[0].token}` : null, cached: true });
    }
  } catch (e) {}

  const b = buildBase(division, coreDone, coreGpa, gradYear, new Date());
  let reads = ANTHROPIC_API_KEY ? await aiReads(b, ANTHROPIC_API_KEY) : null;
  if (!reads) reads = templatedReads(b);

  const cap600 = (s) => stripTags(s).slice(0, 600);
  const clean = {
    division: b.R.label,
    who: b.R.label + ' · Core GPA ' + coreGpa.toFixed(2) + ' · Class of ' + gradYear,
    hero: stripTags(b.hero).slice(0, 40),
    hero_small: b.hero.length > 10,
    hero_sub: stripTags(b.heroSub).slice(0, 80),
    verdict: stripTags(b.verdict).slice(0, 120),
    first_read: stripTags(b.first_read).slice(0, 280),
    rows: b.rows.map(r => ({ label: stripTags(r.label).slice(0, 60), value: stripTags(r.value).slice(0, 170), accent: !!r.accent })),
    reads: [
      { kicker: 'Your flags, in plain terms', text: cap600(reads.flags) },
      { kicker: 'What to do next', text: cap600(reads.fix) },
      { kicker: 'The official word', text: cap600(reads.official) },
    ],
  };

  const reportToken = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  try {
    await sb('eligibility_reports', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ full_name: fullName, email, division, core_done: coreDone, core_gpa: coreGpa, grad_year: gradYear, verdict: clean.hero + ' — ' + clean.verdict, report: clean, ip: ip || null, token: reportToken }),
    });
  } catch (e) {}

  const shareUrl = `${base}/report.html?t=${reportToken}`;
  if (RESEND_API_KEY) {
    const from = EMAIL_FROM || 'onboarding@resend.dev';
    const replyTo = EMAIL_REPLY_TO || 'keyona@rerev.io';
    const firstName = (fullName.split(' ')[0] || 'there').slice(0, 40);
    try { await emailParent({ to: email, firstName, clean, shareUrl, key: RESEND_API_KEY, from, replyTo }); } catch (e) {}
    try { await notifyInternal({ lead: { full_name: fullName, email, core_gpa: coreGpa.toFixed(2), core_done: coreDone, grad_year: gradYear }, clean, shareUrl, key: RESEND_API_KEY, from, notifyTo: LEAD_NOTIFY_TO || replyTo }); } catch (e) {}
  }

  return json(200, { ...clean, token: reportToken, share_path: `/report.html?t=${reportToken}` });
};
