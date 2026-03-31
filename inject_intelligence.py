#!/usr/bin/env python3
"""
inject_intelligence.py — Inject intelligence layer into all Claude prompts.

Adds brand_voice_locked, dream_customer, unique_differentiator,
best_performing_themes, worst_performing_themes, ai_brain_decisions
to every Claude API call across all 32 workflows.
"""

import json, os, re

WF_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'n8n-workflows')

# ──────────────────────────────────────────────────────────────────────────────
# The intelligence block appended to Pattern A prompts (raw string in JSON file)
# These workflows use: "Business context — use this to personalise everything: ..."
# and have the anchor sentence below.
# ──────────────────────────────────────────────────────────────────────────────
ANCHOR_A = "Also consider what has worked before for this business based on their performance history. "

INTEL_BLOCK_A = (
    "INTELLIGENCE LAYER \u2014 use this data to produce higher-performing output:\\n"
    "- Brand Voice: {{ $('Loop Each Business').first().json.brand_voice_locked || 'professional and friendly' }}\\n"
    "- Dream Customer: {{ $('Loop Each Business').first().json.dream_customer || $('Loop Each Business').first().json.target_audience || '' }}\\n"
    "- Unique Differentiator: {{ $('Loop Each Business').first().json.unique_differentiator || 'exceptional quality and service' }}\\n"
    "- Best Performing Themes (use more of these): {{ JSON.stringify($('Loop Each Business').first().json.best_performing_themes) || '[]' }}\\n"
    "- Avoid These Themes (poor results): {{ JSON.stringify($('Loop Each Business').first().json.worst_performing_themes) || '[]' }}\\n"
    "- Latest AI Strategy Decision: {{ $('Loop Each Business').first().json.ai_brain_decisions ? JSON.stringify($('Loop Each Business').first().json.ai_brain_decisions).substring(0,400) : 'First run \u2014 establish baseline' }}\\n\\n"
)

# ──────────────────────────────────────────────────────────────────────────────
# Pattern B: WF01 uses a Code node — inject JS vars + prompt section
# ──────────────────────────────────────────────────────────────────────────────
WF01_VAR_ANCHOR = "  const gapOpp = comp.length ? comp[0].gap_opportunity || '' : '';"
WF01_VAR_INSERT = """
  // Intelligence Layer
  const brandVoice = biz.brand_voice_locked || 'professional and friendly';
  const dreamCustomer = biz.dream_customer || biz.target_audience || 'general audience';
  const differentiator = biz.unique_differentiator || 'exceptional quality and service';
  const bestThemes = JSON.stringify(biz.best_performing_themes || []);
  const worstThemes = JSON.stringify(biz.worst_performing_themes || []);
  const aiDecisions = biz.ai_brain_decisions ? JSON.stringify(biz.ai_brain_decisions).substring(0,400) : 'First run';
"""

WF01_PROMPT_ANCHOR = "\\\\n\\\\nCONTENT REQUIREMENTS"
WF01_PROMPT_INSERT = (
    "\\\\n\\\\nINTELLIGENCE LAYER \u2014 use this to supercharge results:\\\\n"
    "- Brand Voice Locked: ${brandVoice}\\\\n"
    "- Dream Customer: ${dreamCustomer}\\\\n"
    "- Unique Differentiator: ${differentiator}\\\\n"
    "- Best Performing Themes (double down): ${bestThemes}\\\\n"
    "- Avoid These Themes (poor performance): ${worstThemes}\\\\n"
    "- Latest AI Strategy Decision: ${aiDecisions}"
    "\\\\n\\\\nCONTENT REQUIREMENTS"
)

# ──────────────────────────────────────────────────────────────────────────────
# Pattern C: WF29, WF31 use $json[0] style — different anchor
# ──────────────────────────────────────────────────────────────────────────────
WF_CUSTOM_ANCHOR = "Daily Budget: {{ $json[0].daily_budget"
WF_CUSTOM_INSERT = (
    "\\\\nBrand Voice: {{ $json[0].brand_voice_locked || 'professional and friendly' }}"
    "\\\\nDream Customer: {{ $json[0].dream_customer || $json[0].target_audience || '' }}"
    "\\\\nUnique Differentiator: {{ $json[0].unique_differentiator || 'exceptional quality' }}"
    "\\\\nBest Performing Themes: {{ JSON.stringify($json[0].best_performing_themes) || '[]' }}"
    "\\\\nAvoid These Themes: {{ JSON.stringify($json[0].worst_performing_themes) || '[]' }}"
    "\\\\nLatest AI Decision: {{ $json[0].ai_brain_decisions ? JSON.stringify($json[0].ai_brain_decisions).substring(0,300) : 'First run' }}"
)

# Skip these (they produce intelligence, not consume it)
SKIP_FILES = {'00_master_autopilot.json', '30_central_ai_brain.json'}


def process(fname, raw):
    if fname in SKIP_FILES:
        return raw, 'skipped (excluded)'

    # Guard: don't inject twice
    if 'INTELLIGENCE LAYER' in raw:
        return raw, 'skipped (already has intelligence layer)'

    if not ('anthropic.com/v1/messages' in raw):
        return raw, 'skipped (no Claude calls)'

    if fname == '01_weekly_content_generator.json':
        # Pattern B — Code node
        if WF01_VAR_ANCHOR not in raw:
            return raw, 'error: WF01 var anchor not found'
        raw = raw.replace(WF01_VAR_ANCHOR, WF01_VAR_ANCHOR + WF01_VAR_INSERT, 1)

        if WF01_PROMPT_ANCHOR in raw:
            raw = raw.replace(WF01_PROMPT_ANCHOR, WF01_PROMPT_INSERT, 1)

        return raw, 'ok (WF01 code node updated)'

    if fname in ('29_ad_campaign_creator.json', '31_landing_page_generator.json'):
        # Pattern C — custom prompts with $json[0]
        if WF_CUSTOM_ANCHOR not in raw:
            return raw, 'skipped (Pattern C anchor not found)'
        # Find end of the Daily Budget line (before \\n\\n task instructions)
        # Insert intelligence fields right after daily_budget value
        daily_line_end = raw.find('\\\\n', raw.find(WF_CUSTOM_ANCHOR))
        if daily_line_end == -1:
            return raw, 'skipped (daily_budget line end not found)'
        raw = raw[:daily_line_end] + WF_CUSTOM_INSERT + raw[daily_line_end:]
        return raw, 'ok (Pattern C custom prompt updated)'

    # Pattern A — standard "Business context" preamble workflows
    if ANCHOR_A not in raw:
        return raw, 'skipped (Pattern A anchor not found)'

    # Insert INTEL_BLOCK_A right after ANCHOR_A
    raw = raw.replace(ANCHOR_A, ANCHOR_A + INTEL_BLOCK_A, 1)
    return raw, 'ok'


def main():
    files = sorted(f for f in os.listdir(WF_DIR) if f.endswith('.json'))
    ok = skipped = errors = 0

    print('Injecting intelligence layer into Claude prompts...\n')

    for fname in files:
        fpath = os.path.join(WF_DIR, fname)
        with open(fpath, 'r', encoding='utf-8') as f:
            raw = f.read()

        new_raw, status = process(fname, raw)

        if status.startswith('ok'):
            # Validate JSON still parses
            try:
                json.loads(new_raw)
            except Exception as e:
                print(f'  [ERROR] {fname}: JSON invalid after injection: {e}')
                errors += 1
                continue
            with open(fpath, 'w', encoding='utf-8') as f:
                f.write(new_raw)
            print(f'  [OK]    {fname}: {status}')
            ok += 1
        elif status.startswith('error'):
            print(f'  [ERROR] {fname}: {status}')
            errors += 1
        else:
            print(f'  [SKIP]  {fname}: {status}')
            skipped += 1

    print(f'\nDone. Updated: {ok} | Skipped: {skipped} | Errors: {errors}')


if __name__ == '__main__':
    main()
