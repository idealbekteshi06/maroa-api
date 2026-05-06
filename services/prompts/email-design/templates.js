'use strict';

/**
 * services/prompts/email-design/templates.js
 * ----------------------------------------------------------------------------
 * HTML email templates. All inline-styled. Mobile-optimized via media query
 * shim (where supported). Plain-text fallback auto-generated.
 *
 * Templates:
 *   scorecard          — weekly performance digest
 *   monthlyReport      — longer-form retrospective
 *   adAuditSummary     — single audit decision + chart
 *   contentApproval    — pending content awaiting owner approval
 * ----------------------------------------------------------------------------
 */

const charts = require('./svg-charts');
const adI18n = require('../ad-optimizer/i18n-market');

// ─── Color helpers ─────────────────────────────────────────────────────────

const INDUSTRY_COLOR_DEFAULTS = {
  cafe:        '#A0522D', // sienna
  restaurant:  '#B91C1C', // warm red
  bar:         '#1E1B4B', // dark indigo
  dental:      '#0E7490', // teal
  clinic:      '#0E7490',
  gym:         '#DC2626', // strong red
  boutique:    '#831843', // wine
  retail:      '#3B82F6',
  plumber:     '#1D4ED8', // deep blue
  contractor:  '#1F2937', // graphite
  saas:        '#3B82F6', // bright blue
  software:    '#6366F1',
  salon:       '#BE185D', // pink
  spa:         '#059669', // emerald
  realestate:  '#1E40AF',
};

function brandColor(business) {
  if (business?.brand_color_primary && /^#[0-9a-f]{3,6}$/i.test(business.brand_color_primary)) {
    return business.brand_color_primary;
  }
  const ind = String(business?.industry || business?.business_type || '').toLowerCase();
  for (const [k, c] of Object.entries(INDUSTRY_COLOR_DEFAULTS)) {
    if (ind.includes(k)) return c;
  }
  return '#3B82F6';
}

function darken(hex, amount = 0.25) {
  // Simple darken — strip #, parse, multiply each channel by (1-amount)
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 0xff) * (1 - amount));
  const g = Math.round(((n >> 8) & 0xff) * (1 - amount));
  const b = Math.round((n & 0xff) * (1 - amount));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

// ─── Common shell ──────────────────────────────────────────────────────────

function htmlShell({ business, marketProfile, body, color, isRtl }) {
  const dir = isRtl ? 'rtl' : 'ltr';
  const lang = marketProfile?.primary_language || 'en';
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" dir="${dir}">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="x-apple-disable-message-reformatting"/>
<title>${escapeHtml(business?.business_name || 'Maroa')}</title>
</head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;line-height:1.5;-webkit-text-size-adjust:100%;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F9FAFB;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
${body}
<tr><td style="padding:20px 28px;background:#F9FAFB;font-size:11px;color:#6B7280;text-align:center;border-top:1px solid #E5E7EB;">
Sent by Maroa.ai for ${escapeHtml(business?.business_name || '')} · <a href="https://maroa.ai" style="color:${color};text-decoration:none;">maroa.ai</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function header({ business, color, eyebrow }) {
  const name = escapeHtml(business?.business_name || 'Your business');
  const logo = business?.logo_url ? `<img src="${escapeAttr(business.logo_url)}" alt="${name}" width="40" height="40" style="display:block;border-radius:8px;border:0;"/>` : '';
  return `<tr><td style="padding:28px 28px 12px;border-bottom:3px solid ${color};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td valign="middle" style="width:48px;">${logo}</td>
<td valign="middle" style="padding-left:${logo ? '12px' : '0'};">
${eyebrow ? `<div style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${escapeHtml(eyebrow)}</div>` : ''}
<div style="font-size:22px;font-weight:700;color:#111827;line-height:1.2;">${name}</div>
</td>
</tr>
</table>
</td></tr>`;
}

// ─── Scorecard email ──────────────────────────────────────────────────────

/**
 * Build a weekly scorecard email — the upgraded designer-grade version.
 */
function scorecard({ business, marketProfile, scorecardData, commentary }) {
  const color = brandColor(business);
  const colorDark = darken(color, 0.30);
  const isRtl = marketProfile?.text_direction === 'rtl';
  const lang = marketProfile?.primary_language || 'en';

  const week = scorecardData?.week || {};
  const deltas = scorecardData?.deltas || {};

  const fmtMoney = (v) => Number.isFinite(v)
    ? adI18n.formatMoney(v, marketProfile?.currency || 'USD', marketProfile?.locale || 'en-US')
    : '—';
  const fmtPct = (v) => {
    if (!Number.isFinite(v)) return '';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${(v * 100).toFixed(0)}%`;
  };
  const fmtNum = (v) => Number.isFinite(v) ? Math.round(v).toLocaleString(marketProfile?.locale || 'en-US') : '—';

  // Build sparkline if 7d daily data is present
  const dailySparkline = Array.isArray(scorecardData?.roas_daily_7d) && scorecardData.roas_daily_7d.length >= 2
    ? charts.sparkline({ values: scorecardData.roas_daily_7d, color, width: 160, height: 36 })
    : '';

  // Build campaign comparison bar chart (top 3 by spend)
  const campaignsRanked = Array.isArray(scorecardData?.campaigns_ranked) ? scorecardData.campaigns_ranked.slice(0, 3) : [];
  const campaignBar = campaignsRanked.length
    ? charts.bar({
        items: campaignsRanked.map(c => ({
          label: String(c.campaign_name || 'Campaign').slice(0, 14),
          value: c.roas_avg || 0,
        })),
        color,
        valueFormatter: (v) => Number(v).toFixed(2),
        width: 320,
      })
    : '';

  const body = [
    header({ business, color, eyebrow: localizeEyebrow(lang) }),

    // ─── Hero numbers ──
    `<tr><td style="padding:24px 28px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td style="padding:12px 0;border-bottom:1px solid #F3F4F6;">
<div style="font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${localizeLabel(lang, 'spend')}</div>
<div style="font-size:24px;font-weight:700;color:#111827;line-height:1.2;">${fmtMoney(week.spend)}</div>
${Number.isFinite(deltas.spend_pct) ? `<div style="font-size:12px;color:${deltas.spend_pct >= 0 ? '#059669' : '#DC2626'};margin-top:2px;">${fmtPct(deltas.spend_pct)} ${localizeLabel(lang, 'vs_prev_week')}</div>` : ''}
</td>
</tr>
<tr>
<td style="padding:12px 0;border-bottom:1px solid #F3F4F6;">
<div style="font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${localizeLabel(lang, 'conversions')}</div>
<div style="font-size:24px;font-weight:700;color:#111827;line-height:1.2;">${fmtNum(week.conversions)}</div>
${Number.isFinite(deltas.conversions_pct) ? `<div style="font-size:12px;color:${deltas.conversions_pct >= 0 ? '#059669' : '#DC2626'};margin-top:2px;">${fmtPct(deltas.conversions_pct)} ${localizeLabel(lang, 'vs_prev_week')}</div>` : ''}
</td>
</tr>
<tr>
<td style="padding:12px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td valign="top">
<div style="font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">${localizeLabel(lang, 'avg_roas')}</div>
<div style="font-size:24px;font-weight:700;color:${colorDark};line-height:1.2;">${Number.isFinite(week.roas) ? Number(week.roas).toFixed(2) : '—'}</div>
${Number.isFinite(deltas.roas_pct) ? `<div style="font-size:12px;color:${deltas.roas_pct >= 0 ? '#059669' : '#DC2626'};margin-top:2px;">${fmtPct(deltas.roas_pct)} ${localizeLabel(lang, 'vs_prev_week')}</div>` : ''}
</td>
${dailySparkline ? `<td valign="top" align="right" style="width:170px;">${dailySparkline}<div style="font-size:10px;color:#9CA3AF;text-align:right;">${localizeLabel(lang, 'last_7_days')}</div></td>` : ''}
</tr>
</table>
</td>
</tr>
</table>
</td></tr>`,

    // ─── Commentary ──
    commentary?.trend_interpretation ? `<tr><td style="padding:8px 28px 16px;">
<div style="background:#F9FAFB;border-left:3px solid ${color};padding:14px 16px;border-radius:6px;font-size:14px;color:#374151;">
${escapeHtml(commentary.trend_interpretation)}
</div>
</td></tr>` : '',

    // ─── Campaigns chart ──
    campaignBar ? `<tr><td style="padding:8px 28px 16px;">
<div style="font-size:14px;font-weight:600;color:#111827;margin-bottom:8px;">${localizeLabel(lang, 'top_campaigns_by_roas')}</div>
${campaignBar}
</td></tr>` : '',

    // ─── Top actions ──
    Array.isArray(commentary?.top_actions) && commentary.top_actions.length
      ? `<tr><td style="padding:8px 28px 20px;">
<div style="font-size:14px;font-weight:600;color:#111827;margin-bottom:10px;">${localizeLabel(lang, 'next_actions')}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${commentary.top_actions.map((a, i) => `<tr><td valign="top" style="padding:8px 0;border-bottom:1px solid #F3F4F6;">
<div style="display:inline-block;width:22px;height:22px;line-height:22px;border-radius:11px;background:${color};color:#fff;text-align:center;font-size:12px;font-weight:600;margin-right:10px;vertical-align:top;">${i + 1}</div>
<div style="display:inline-block;vertical-align:top;width:calc(100% - 36px);font-size:13px;color:#111827;">${escapeHtml(a.action || a)} ${a.time_to_ship_minutes ? `<span style="color:#9CA3AF;font-size:11px;"> · ~${a.time_to_ship_minutes}min</span>` : ''}</div>
</td></tr>`).join('\n')}
</table>
</td></tr>`
      : '',

    // ─── Win of the week ──
    commentary?.win_of_the_week ? `<tr><td style="padding:8px 28px 24px;">
<div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:14px 16px;font-size:14px;color:#065F46;">
🌱 ${escapeHtml(commentary.win_of_the_week)}
</div>
</td></tr>` : '',
  ].filter(Boolean).join('\n');

  const html = htmlShell({ business, marketProfile, body, color, isRtl });
  const subject = localizeSubject(lang, business?.business_name || '', 'scorecard');
  const previewText = commentary?.trend_interpretation
    ? String(commentary.trend_interpretation).slice(0, 100)
    : `${week.conversions || 0} ${localizeLabel(lang, 'conversions')} · ${fmtMoney(week.spend)} ${localizeLabel(lang, 'spend')}`;
  const plainText = scorecardPlainText({ business, marketProfile, scorecardData, commentary });

  return { html, plain_text: plainText, subject, preview_text: previewText };
}

function scorecardPlainText({ business, marketProfile, scorecardData, commentary }) {
  const week = scorecardData?.week || {};
  const lang = marketProfile?.primary_language || 'en';
  const fmtMoney = (v) => Number.isFinite(v)
    ? adI18n.formatMoney(v, marketProfile?.currency || 'USD', marketProfile?.locale || 'en-US')
    : '—';
  const lines = [
    `${business?.business_name || 'Your business'} — ${localizeLabel(lang, 'weekly_scorecard')}`,
    '',
    `${localizeLabel(lang, 'spend')}: ${fmtMoney(week.spend)}`,
    `${localizeLabel(lang, 'conversions')}: ${week.conversions || 0}`,
    `${localizeLabel(lang, 'avg_roas')}: ${Number.isFinite(week.roas) ? Number(week.roas).toFixed(2) : '—'}`,
    '',
  ];
  if (commentary?.trend_interpretation) {
    lines.push(commentary.trend_interpretation, '');
  }
  if (Array.isArray(commentary?.top_actions) && commentary.top_actions.length) {
    lines.push(localizeLabel(lang, 'next_actions') + ':');
    commentary.top_actions.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.action || a}`);
    });
    lines.push('');
  }
  if (commentary?.win_of_the_week) {
    lines.push(commentary.win_of_the_week);
  }
  return lines.join('\n');
}

// ─── Ad audit summary email ────────────────────────────────────────────────

function adAuditSummary({ business, marketProfile, audit, narrative }) {
  const color = brandColor(business);
  const isRtl = marketProfile?.text_direction === 'rtl';
  const lang = marketProfile?.primary_language || 'en';

  const decisionColor = ({
    scale: '#10B981',
    pause: '#EF4444',
    keep: '#3B82F6',
    optimize: '#F59E0B',
    refresh_creative: '#8B5CF6',
  })[audit?.decision] || '#3B82F6';

  const scoreGauge = audit?.audit_score != null
    ? charts.gauge({ value: audit.audit_score, label: localizeLabel(lang, 'audit_score'), width: 160 })
    : '';

  const body = [
    header({ business, color, eyebrow: localizeEyebrow(lang, 'ad_audit') }),
    `<tr><td style="padding:24px 28px;">
<div style="display:inline-block;padding:6px 14px;background:${decisionColor};color:#fff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;border-radius:999px;margin-bottom:16px;">${escapeHtml(audit?.decision || 'review')}</div>
<div style="font-size:18px;font-weight:600;color:#111827;line-height:1.4;margin-bottom:12px;">${escapeHtml(audit?.decision_reason || '')}</div>
${scoreGauge ? `<div style="text-align:center;margin:16px 0;">${scoreGauge}</div>` : ''}
${narrative?.narrative_full ? `<div style="background:#F9FAFB;border-left:3px solid ${color};padding:14px 16px;border-radius:6px;font-size:14px;color:#374151;line-height:1.6;">${escapeHtml(narrative.narrative_full)}</div>` : ''}
</td></tr>`,
  ].join('\n');

  const html = htmlShell({ business, marketProfile, body, color, isRtl });
  return {
    html,
    plain_text: `${business?.business_name || ''} — ${localizeLabel(lang, 'ad_audit')}\n\nDecision: ${audit?.decision}\nReason: ${audit?.decision_reason}\n\n${narrative?.narrative_full || ''}`,
    subject: localizeSubject(lang, business?.business_name || '', 'ad_audit'),
    preview_text: audit?.decision_reason ? String(audit.decision_reason).slice(0, 100) : '',
  };
}

// ─── Localizations (small set; expand as needed) ───────────────────────────

const LABELS = {
  en: { spend: 'Spend', conversions: 'Conversions', avg_roas: 'Avg ROAS', vs_prev_week: 'vs prev week', last_7_days: 'last 7 days', top_campaigns_by_roas: 'Top campaigns by ROAS', next_actions: 'Top actions for next week', weekly_scorecard: 'Weekly Scorecard', audit_score: 'Audit Score', ad_audit: 'Ad Audit' },
  sq: { spend: 'Shpenzime', conversions: 'Konvertime', avg_roas: 'ROAS Mes.', vs_prev_week: 'vs jav. prej.', last_7_days: '7 ditët e fundit', top_campaigns_by_roas: 'Fushatat kryesore', next_actions: 'Veprimet për javën tjetër', weekly_scorecard: 'Raporti Javor', audit_score: 'Pikët', ad_audit: 'Auditi i Reklamave' },
  es: { spend: 'Gasto', conversions: 'Conversiones', avg_roas: 'ROAS Prom.', vs_prev_week: 'vs sem. ant.', last_7_days: 'últimos 7 días', top_campaigns_by_roas: 'Mejores campañas por ROAS', next_actions: 'Acciones para la próxima semana', weekly_scorecard: 'Reporte Semanal', audit_score: 'Puntuación', ad_audit: 'Auditoría de Anuncios' },
  fr: { spend: 'Dépenses', conversions: 'Conversions', avg_roas: 'ROAS Moy.', vs_prev_week: 'vs sem. préc.', last_7_days: '7 derniers jours', top_campaigns_by_roas: 'Meilleures campagnes par ROAS', next_actions: 'Actions pour la semaine prochaine', weekly_scorecard: 'Rapport Hebdomadaire', audit_score: 'Score', ad_audit: 'Audit des Annonces' },
  de: { spend: 'Ausgaben', conversions: 'Konversionen', avg_roas: 'Ø ROAS', vs_prev_week: 'vs Vorwoche', last_7_days: 'letzte 7 Tage', top_campaigns_by_roas: 'Top Kampagnen nach ROAS', next_actions: 'Aktionen für nächste Woche', weekly_scorecard: 'Wochenbericht', audit_score: 'Audit Score', ad_audit: 'Anzeigen-Audit' },
  it: { spend: 'Spesa', conversions: 'Conversioni', avg_roas: 'ROAS Med.', vs_prev_week: 'vs sett. prec.', last_7_days: 'ultimi 7 giorni', top_campaigns_by_roas: 'Migliori campagne per ROAS', next_actions: 'Azioni per la prossima settimana', weekly_scorecard: 'Riepilogo Settimanale', audit_score: 'Punteggio', ad_audit: 'Audit Annunci' },
  pt: { spend: 'Gasto', conversions: 'Conversões', avg_roas: 'ROAS Méd.', vs_prev_week: 'vs sem. ant.', last_7_days: 'últimos 7 dias', top_campaigns_by_roas: 'Principais campanhas por ROAS', next_actions: 'Ações para a próxima semana', weekly_scorecard: 'Relatório Semanal', audit_score: 'Pontuação', ad_audit: 'Auditoria de Anúncios' },
};

function localizeLabel(lang, key) {
  return (LABELS[lang] && LABELS[lang][key]) || (LABELS.en[key]) || key;
}

function localizeEyebrow(lang, kind = 'weekly') {
  if (kind === 'ad_audit') {
    return ({
      en: 'Ad Audit', sq: 'Auditi i Reklamave', es: 'Auditoría de Anuncios',
      fr: 'Audit des Annonces', de: 'Anzeigen-Audit', it: 'Audit Annunci', pt: 'Auditoria de Anúncios',
    })[lang] || 'Ad Audit';
  }
  return ({
    en: 'Weekly Scorecard', sq: 'Raporti Javor', es: 'Reporte Semanal',
    fr: 'Rapport Hebdomadaire', de: 'Wochenbericht', it: 'Riepilogo Settimanale', pt: 'Relatório Semanal',
  })[lang] || 'Weekly Scorecard';
}

function localizeSubject(lang, name, kind) {
  if (kind === 'scorecard') {
    return ({
      en: `${name} — your weekly scorecard is in`,
      sq: `${name} — raporti yt javor është gati`,
      es: `${name} — tu reporte semanal está listo`,
      fr: `${name} — votre rapport hebdomadaire est prêt`,
      de: `${name} — Ihr Wochenbericht ist da`,
      it: `${name} — il tuo riepilogo settimanale è pronto`,
      pt: `${name} — seu relatório semanal está pronto`,
    })[lang] || `${name} — your weekly scorecard is in`;
  }
  if (kind === 'ad_audit') {
    return ({
      en: `${name} — ad audit results`,
      sq: `${name} — rezultatet e auditit`,
      es: `${name} — resultados de auditoría`,
      fr: `${name} — résultats de l'audit`,
      de: `${name} — Audit-Ergebnisse`,
      it: `${name} — risultati audit`,
      pt: `${name} — resultados da auditoria`,
    })[lang] || `${name} — ad audit results`;
  }
  return name;
}

// ─── Escapes ───────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/"/g, '%22').replace(/\n/g, '');
}

module.exports = {
  brandColor,
  darken,
  scorecard,
  adAuditSummary,
  LABELS,
  localizeLabel,
  localizeEyebrow,
  localizeSubject,
};
