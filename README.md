# Eligibility Quick Screen (T033)

An Athlete Site Pixie (Tool Registry T033). NCAA initial-eligibility risk flags, before it becomes a senior-year emergency. A parent enters their name, email, division target (DI or DII), core-course progress against the 16 required, core-course GPA, and graduation year; the tool returns an On Track / At Risk / Off Track risk read with the specific flags and next steps. Every run captures a lead in Supabase, emails the parent their card, and fires an internal notification.

Forked file-for-file from T030 Scholarship Reality; only the engine, inputs, and card output changed.

**This gives risk flags, not an official determination.** Every result points the family to the NCAA Eligibility Center, which is the only body that certifies eligibility. The tool makes no promise of eligibility.

The rules are **deterministic** from sourced NCAA requirements (current 2025-26, pulled live at build from the NCAA Eligibility Center / NCAA.org). Claude Haiku only writes the plain-language reads around the computed flags; templated fallback so the tool never hard-fails. No web search.

## What's where

- `index.html` — the tool people use (division, core courses, core GPA, grad year)
- `report.html` — the shareable result card, with Download-as-PNG; reached at `/report.html?t=TOKEN`
- `netlify/functions/eligibility.js` — runs a report: validate, Turnstile, apply rules, Haiku reads, save to Supabase, email parent + notify you
- `netlify/functions/get-report.js` — reads one saved card by its token
- `supabase.sql` — the leads/results table (`eligibility_reports`)

## The rules it checks (current 2025-26)

- **16 core courses**, with the DI breakdown (4 English / 3 math / 2 science / 1 extra / 2 social science / 4 additional) and the DII breakdown (3 / 2 / 2 / 3 / 2 / 4).
- **Core-GPA floor:** DI 2.300, DII 2.200. No sliding scale — GPA stands alone.
- **DI progression / 10-of-16 rule:** 10 core courses (7 in English/math/science) must be done before the 7th semester (senior year), and those grades then lock. DII has no such rule.
- **Qualifier tiers:** DI Full Qualifier / Academic Redshirt (>= 2.0, practice + aid but no competition) / Nonqualifier; DII Full Qualifier / Partial Qualifier / Nonqualifier.
- **Tests:** standardized test scores are NOT required for NCAA initial eligibility; colleges may still want them for admission.

The risk read is the worst of three checks: core-GPA status, core-course pace for the athlete's grade, and (DI only) the 10-of-16 timing.

## Setup (one time)

Reuses the existing `online-report-card` Supabase project (shared with T028/T030/T031/T032), so `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are already valid — the `eligibility_reports` table is already applied live.

### Netlify
1. Add a new site from this GitHub repo (the one manual OAuth step). Build settings come from `netlify.toml`.
2. Site configuration -> Environment variables: copy `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` from the T030 site; set `DAILY_CAP` (e.g. `200`), `EMAIL_FROM` (`Athlete Site <reports@rerev.io>`), `EMAIL_REPLY_TO` (`keyona@rerev.io`), `LEAD_NOTIFY_TO` (`keyona@rerev.io`); paste `RESEND_API_KEY` once; add a fresh `TURNSTILE_SECRET` for this domain.
3. In `index.html`, replace `YOUR_TURNSTILE_SITE_KEY` with the new widget's Site key.
4. Deploy.

## How the emails work
- The **parent** gets a clean-subject email: "{First}, your NCAA eligibility risk read," with a link to their card.
- **You** get a second email on every lead, subject `[T033 · Eligibility Screen] New lead - {name}, {division} ({read})`.

## Guards in place
All secrets server-side; required name + email gate; Cloudflare Turnstile; daily cap + per-IP rate limit (4 / 10 min); 30-day result cache; server-side validation + HTML-escaped rendering; shareable pages keyed by an unguessable token; leads table private behind RLS.

## Framing caveat (important)
This is a risk screen, not an official determination. Every card and email carries that line and points to the NCAA Eligibility Center (eligibilitycenter.org). v1 covers DI and DII; NAIA uses a separate standard and is intentionally out of scope.
