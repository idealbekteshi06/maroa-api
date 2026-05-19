#!/usr/bin/env python3
"""Generate n8n workflow JSON files 29, 30, and 31 for Maroa.ai"""

import json
import os
import uuid

OUTPUT_DIR = "/Users/bekteshi/Desktop/Maroa.ai/n8n-workflows"
SUPABASE_URL = "https://zqhyrbttuqkvmdewiytf.supabase.co"
SUPABASE_KEY = "{{ $env.SUPABASE_KEY }}"
ANTHROPIC_KEY = "{{ $env.ANTHROPIC_API_KEY }}"
GMAIL_CRED = {"gmailOAuth2": {"id": "BajY2aODIl8cGn0X", "name": "Gmail account"}}

def uid():
    return str(uuid.uuid4())

def supabase_get_headers():
    return {
        "parameters": [
            {"name": "apikey", "value": SUPABASE_KEY},
            {"name": "Authorization", "value": f"Bearer {SUPABASE_KEY}"}
        ]
    }

def supabase_post_headers():
    return {
        "parameters": [
            {"name": "apikey", "value": SUPABASE_KEY},
            {"name": "Authorization", "value": f"Bearer {SUPABASE_KEY}"},
            {"name": "Content-Type", "value": "application/json"},
            {"name": "Prefer", "value": "return=representation"}
        ]
    }

def supabase_patch_headers():
    return {
        "parameters": [
            {"name": "apikey", "value": SUPABASE_KEY},
            {"name": "Authorization", "value": f"Bearer {SUPABASE_KEY}"},
            {"name": "Content-Type", "value": "application/json"},
            {"name": "Prefer", "value": "return=representation"}
        ]
    }

def anthropic_headers():
    return {
        "parameters": [
            {"name": "x-api-key", "value": ANTHROPIC_KEY},
            {"name": "anthropic-version", "value": "2023-06-01"},
            {"name": "Content-Type", "value": "application/json"}
        ]
    }

# ─────────────────────────────────────────────────────────────────────────────
# WF29 – AD CAMPAIGN CREATOR
# ─────────────────────────────────────────────────────────────────────────────
def build_wf29():
    ids = {k: uid() for k in [
        "manual", "webhook", "extract", "get_biz", "check_budget",
        "call_claude", "parse", "save_awareness", "save_engagement",
        "save_retargeting", "send_email"
    ]}

    # Claude prompt for campaign creator
    campaign_prompt = (
        "You are a Facebook Ads expert. Create 3 distinct ad campaigns for "
        "{{ $('Extract Data').first().json.business_name }} "
        "({{ $('Get Business').first().json.industry }}) in "
        "{{ $('Get Business').first().json.location }}. "
        "Target audience: {{ $('Get Business').first().json.target_audience }}. "
        "Marketing goal: {{ $('Get Business').first().json.marketing_goal }}. "
        "Brand tone: {{ $('Get Business').first().json.brand_tone }}. "
        "Daily budget available: ${{ $('Get Business').first().json.daily_budget }}. "
        "Return ONLY valid JSON with this structure: "
        "{ \"awareness_campaign\": { \"campaign_name\": \"string max 50 chars\", "
        "\"ad_headline\": \"string max 30 chars\", "
        "\"ad_description\": \"string max 90 chars\", "
        "\"call_to_action\": \"LEARN_MORE or SIGN_UP or CONTACT_US or SHOP_NOW\", "
        "\"audience_description\": \"cold audience targeting description\", "
        "\"budget_percentage\": 40, "
        "\"campaign_angle\": \"brief explanation of the angle\" }, "
        "\"engagement_campaign\": { \"campaign_name\": \"string\", "
        "\"ad_headline\": \"string max 30 chars\", "
        "\"ad_description\": \"string max 90 chars\", "
        "\"call_to_action\": \"string\", "
        "\"audience_description\": \"page fans and engaged users\", "
        "\"budget_percentage\": 35, "
        "\"campaign_angle\": \"string\" }, "
        "\"retargeting_campaign\": { \"campaign_name\": \"string\", "
        "\"ad_headline\": \"string max 30 chars\", "
        "\"ad_description\": \"string max 90 chars\", "
        "\"call_to_action\": \"string\", "
        "\"audience_description\": \"website visitors and lookalikes\", "
        "\"budget_percentage\": 25, "
        "\"campaign_angle\": \"string\" } } "
        "Return only valid JSON, no markdown."
    )

    nodes = [
        {
            "parameters": {},
            "id": ids["manual"],
            "name": "Manual Trigger",
            "type": "n8n-nodes-base.manualTrigger",
            "typeVersion": 1,
            "position": [240, 300]
        },
        {
            "parameters": {
                "httpMethod": "POST",
                "path": "create-campaigns",
                "options": {},
                "responseMode": "onReceived"
            },
            "id": ids["webhook"],
            "name": "Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [240, 500]
        },
        {
            "parameters": {
                "jsCode": (
                    "try {\n"
                    "  const items = $input.all();\n"
                    "  const results = [];\n"
                    "  for (const item of items) {\n"
                    "    const body = item.json.body || item.json;\n"
                    "    results.push({json: {\n"
                    "      business_id: body.business_id || '',\n"
                    "      email: body.email || '',\n"
                    "      business_name: body.business_name || ''\n"
                    "    }});\n"
                    "  }\n"
                    "  return results;\n"
                    "} catch(e) {\n"
                    "  return [{json:{error: e.message}}];\n"
                    "}"
                )
            },
            "id": ids["extract"],
            "name": "Extract Data",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [460, 300]
        },
        {
            "parameters": {
                "method": "GET",
                "url": f"={SUPABASE_URL}/rest/v1/businesses?select=*&id=eq.{{{{$('Extract Data').first().json.business_id}}}}",
                "sendHeaders": True,
                "headerParameters": supabase_get_headers(),
                "options": {}
            },
            "id": ids["get_biz"],
            "name": "Get Business",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [680, 300]
        },
        {
            "parameters": {
                "jsCode": (
                    "try {\n"
                    "  const items = $input.all();\n"
                    "  const results = [];\n"
                    "  for (const item of items) {\n"
                    "    const biz = Array.isArray(item.json) ? item.json[0] : item.json;\n"
                    "    if (!biz || !biz.daily_budget || biz.daily_budget <= 0) {\n"
                    "      results.push({json: {error: 'No daily budget set', valid: false}});\n"
                    "    } else if (!biz.facebook_page_id) {\n"
                    "      results.push({json: {error: 'No Facebook page connected', valid: false}});\n"
                    "    } else {\n"
                    "      results.push({json: {valid: true, ...biz}});\n"
                    "    }\n"
                    "  }\n"
                    "  return results;\n"
                    "} catch(e) {\n"
                    "  return [{json:{error: e.message, valid: false}}];\n"
                    "}"
                )
            },
            "id": ids["check_budget"],
            "name": "Check Budget",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [900, 300]
        },
        {
            "parameters": {
                "method": "POST",
                "url": "https://api.anthropic.com/v1/messages",
                "sendHeaders": True,
                "headerParameters": anthropic_headers(),
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": (
                    "={\"model\":\"claude-sonnet-4-5\",\"max_tokens\":3000,"
                    "\"messages\":[{\"role\":\"user\",\"content\":\""
                    + campaign_prompt.replace('"', '\\"').replace('\n', '\\n')
                    + "\"}]}"
                ),
                "options": {}
            },
            "id": ids["call_claude"],
            "name": "Call Claude - Campaign Creator",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [1120, 300]
        },
        {
            "parameters": {
                "jsCode": (
                    "try {\n"
                    "  const raw = $input.first().json.content?.[0]?.text || '';\n"
                    "  let c = {};\n"
                    "  try { c = JSON.parse(raw); }\n"
                    "  catch(e) { const m = raw.match(/{[\\s\\S]*}/); if(m) try { c = JSON.parse(m[0]); } catch(e2) {} }\n"
                    "  const biz = $('Get Business').first().json;\n"
                    "  const bizArr = Array.isArray(biz) ? biz[0] : biz;\n"
                    "  const budget = bizArr.daily_budget || 0;\n"
                    "  const extract = $('Extract Data').first().json;\n"
                    "  return [{\n"
                    "    json: {\n"
                    "      business_id: extract.business_id,\n"
                    "      business_name: extract.business_name || bizArr.business_name || '',\n"
                    "      email: extract.email,\n"
                    "      daily_budget: budget,\n"
                    "      awareness: c.awareness_campaign || {},\n"
                    "      engagement: c.engagement_campaign || {},\n"
                    "      retargeting: c.retargeting_campaign || {}\n"
                    "    }\n"
                    "  }];\n"
                    "} catch(e) {\n"
                    "  return [{json:{error: e.message}}];\n"
                    "}"
                )
            },
            "id": ids["parse"],
            "name": "Parse Campaigns",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1340, 300]
        },
        {
            "parameters": {
                "method": "POST",
                "url": f"{SUPABASE_URL}/rest/v1/ad_campaigns",
                "sendHeaders": True,
                "headerParameters": supabase_post_headers(),
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": (
                    "={\"business_id\":\"{{$json.business_id}}\","
                    "\"business_name\":\"{{$json.business_name}}\","
                    "\"status\":\"pending\","
                    "\"last_decision\":\"awareness\","
                    "\"last_decision_reason\":\"{{$json.awareness.campaign_angle}}\","
                    "\"daily_budget\":{{$json.daily_budget * 0.4}}}"
                ),
                "options": {}
            },
            "id": ids["save_awareness"],
            "name": "Save Awareness Campaign",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [1560, 180]
        },
        {
            "parameters": {
                "method": "POST",
                "url": f"{SUPABASE_URL}/rest/v1/ad_campaigns",
                "sendHeaders": True,
                "headerParameters": supabase_post_headers(),
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": (
                    "={\"business_id\":\"{{$('Parse Campaigns').first().json.business_id}}\","
                    "\"business_name\":\"{{$('Parse Campaigns').first().json.business_name}}\","
                    "\"status\":\"pending\","
                    "\"last_decision\":\"engagement\","
                    "\"last_decision_reason\":\"{{$('Parse Campaigns').first().json.engagement.campaign_angle}}\","
                    "\"daily_budget\":{{$('Parse Campaigns').first().json.daily_budget * 0.35}}}"
                ),
                "options": {}
            },
            "id": ids["save_engagement"],
            "name": "Save Engagement Campaign",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [1560, 340]
        },
        {
            "parameters": {
                "method": "POST",
                "url": f"{SUPABASE_URL}/rest/v1/ad_campaigns",
                "sendHeaders": True,
                "headerParameters": supabase_post_headers(),
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": (
                    "={\"business_id\":\"{{$('Parse Campaigns').first().json.business_id}}\","
                    "\"business_name\":\"{{$('Parse Campaigns').first().json.business_name}}\","
                    "\"status\":\"pending\","
                    "\"last_decision\":\"retargeting\","
                    "\"last_decision_reason\":\"{{$('Parse Campaigns').first().json.retargeting.campaign_angle}}\","
                    "\"daily_budget\":{{$('Parse Campaigns').first().json.daily_budget * 0.25}}}"
                ),
                "options": {}
            },
            "id": ids["save_retargeting"],
            "name": "Save Retargeting Campaign",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [1560, 500]
        },
        {
            "parameters": {
                "sendTo": "={{ $('Extract Data').first().json.email }}",
                "subject": "=Your 3 Ad Campaigns Are Ready to Launch, {{ $('Parse Campaigns').first().json.business_name }}!",
                "emailType": "html",
                "message": (
                    "=<html><body style='font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;'>"
                    "<h1 style='color:#1a73e8;'>Your 3 Ad Campaigns Are Ready!</h1>"
                    "<p>Hi {{ $('Parse Campaigns').first().json.business_name }},</p>"
                    "<p>We've created 3 targeted Facebook ad campaigns tailored to your business. Here's your campaign breakdown:</p>"
                    "<hr/>"
                    "<h2 style='color:#34a853;'>Campaign 1: Awareness (40% of budget — ${{ Math.round($('Parse Campaigns').first().json.daily_budget * 0.4) }}/day)</h2>"
                    "<p><strong>Name:</strong> {{ $('Parse Campaigns').first().json.awareness.campaign_name }}</p>"
                    "<p><strong>Headline:</strong> {{ $('Parse Campaigns').first().json.awareness.ad_headline }}</p>"
                    "<p><strong>Description:</strong> {{ $('Parse Campaigns').first().json.awareness.ad_description }}</p>"
                    "<p><strong>CTA:</strong> {{ $('Parse Campaigns').first().json.awareness.call_to_action }}</p>"
                    "<p><strong>Target:</strong> {{ $('Parse Campaigns').first().json.awareness.audience_description }}</p>"
                    "<p><strong>Strategy:</strong> {{ $('Parse Campaigns').first().json.awareness.campaign_angle }}</p>"
                    "<hr/>"
                    "<h2 style='color:#fbbc04;'>Campaign 2: Engagement (35% of budget — ${{ Math.round($('Parse Campaigns').first().json.daily_budget * 0.35) }}/day)</h2>"
                    "<p><strong>Name:</strong> {{ $('Parse Campaigns').first().json.engagement.campaign_name }}</p>"
                    "<p><strong>Headline:</strong> {{ $('Parse Campaigns').first().json.engagement.ad_headline }}</p>"
                    "<p><strong>Description:</strong> {{ $('Parse Campaigns').first().json.engagement.ad_description }}</p>"
                    "<p><strong>CTA:</strong> {{ $('Parse Campaigns').first().json.engagement.call_to_action }}</p>"
                    "<p><strong>Target:</strong> {{ $('Parse Campaigns').first().json.engagement.audience_description }}</p>"
                    "<p><strong>Strategy:</strong> {{ $('Parse Campaigns').first().json.engagement.campaign_angle }}</p>"
                    "<hr/>"
                    "<h2 style='color:#ea4335;'>Campaign 3: Retargeting (25% of budget — ${{ Math.round($('Parse Campaigns').first().json.daily_budget * 0.25) }}/day)</h2>"
                    "<p><strong>Name:</strong> {{ $('Parse Campaigns').first().json.retargeting.campaign_name }}</p>"
                    "<p><strong>Headline:</strong> {{ $('Parse Campaigns').first().json.retargeting.ad_headline }}</p>"
                    "<p><strong>Description:</strong> {{ $('Parse Campaigns').first().json.retargeting.ad_description }}</p>"
                    "<p><strong>CTA:</strong> {{ $('Parse Campaigns').first().json.retargeting.call_to_action }}</p>"
                    "<p><strong>Target:</strong> {{ $('Parse Campaigns').first().json.retargeting.audience_description }}</p>"
                    "<p><strong>Strategy:</strong> {{ $('Parse Campaigns').first().json.retargeting.campaign_angle }}</p>"
                    "<hr/>"
                    "<p style='color:#666;font-size:14px;'>Log in to <a href='https://maroa-ai-marketing-automator.lovable.app'>maroa.ai</a> to activate your campaigns and start driving results!</p>"
                    "</body></html>"
                ),
                "options": {
                    "appendAttribution": False
                }
            },
            "credentials": GMAIL_CRED,
            "id": ids["send_email"],
            "name": "Send Campaign Email",
            "type": "n8n-nodes-base.gmail",
            "typeVersion": 2.1,
            "position": [1780, 340]
        }
    ]

    connections = {
        "Manual Trigger": {"main": [[{"node": "Extract Data", "type": "main", "index": 0}]]},
        "Webhook": {"main": [[{"node": "Extract Data", "type": "main", "index": 0}]]},
        "Extract Data": {"main": [[{"node": "Get Business", "type": "main", "index": 0}]]},
        "Get Business": {"main": [[{"node": "Check Budget", "type": "main", "index": 0}]]},
        "Check Budget": {"main": [[{"node": "Call Claude - Campaign Creator", "type": "main", "index": 0}]]},
        "Call Claude - Campaign Creator": {"main": [[{"node": "Parse Campaigns", "type": "main", "index": 0}]]},
        "Parse Campaigns": {"main": [[
            {"node": "Save Awareness Campaign", "type": "main", "index": 0},
            {"node": "Save Engagement Campaign", "type": "main", "index": 0},
            {"node": "Save Retargeting Campaign", "type": "main", "index": 0}
        ]]},
        "Save Awareness Campaign": {"main": [[{"node": "Send Campaign Email", "type": "main", "index": 0}]]},
        "Save Engagement Campaign": {"main": [[{"node": "Send Campaign Email", "type": "main", "index": 0}]]},
        "Save Retargeting Campaign": {"main": [[{"node": "Send Campaign Email", "type": "main", "index": 0}]]}
    }

    return {
        "name": "WF29 - Ad Campaign Creator",
        "nodes": nodes,
        "connections": connections,
        "active": False,
        "settings": {"executionOrder": "v1"},
        "tags": []
    }


# ─────────────────────────────────────────────────────────────────────────────
# WF30 – CENTRAL AI BRAIN
# ─────────────────────────────────────────────────────────────────────────────
def build_wf30():
    ids = {k: uid() for k in [
        "manual", "schedule", "get_businesses", "loop",
        "get_stats", "get_content", "get_ads", "get_competitors",
        "build_prompt", "call_claude", "parse_decisions",
        "save_decisions", "send_email"
    ]}

    brain_prompt = (
        "You are the AI marketing brain for {{ $('Loop Each Business').first().json.business_name }} "
        "({{ $('Loop Each Business').first().json.industry }}, {{ $('Loop Each Business').first().json.location }}). "
        "Analyze ALL this data and make 5 specific strategic decisions for next month:\\n\\n"
        "DAILY STATS (last 30 days): {{ $('Build AI Brain Prompt').first().json.daily_stats_summary }}\\n"
        "CONTENT PERFORMANCE: {{ $('Build AI Brain Prompt').first().json.content_performance_summary }}\\n"
        "AD PERFORMANCE: {{ $('Build AI Brain Prompt').first().json.ad_performance_summary }}\\n"
        "COMPETITOR INTELLIGENCE: {{ $('Build AI Brain Prompt').first().json.competitor_summary }}\\n"
        "CURRENT STRATEGY: {{ $('Loop Each Business').first().json.marketing_strategy }}\\n\\n"
        "Return ONLY valid JSON: "
        "{ \"content_themes_to_focus\": [\"theme1\", \"theme2\", \"theme3\"], "
        "\"content_themes_to_avoid\": [\"theme1\", \"theme2\"], "
        "\"best_performing_audiences\": \"description\", "
        "\"competitor_counter_strategy\": \"specific action\", "
        "\"optimal_posting_schedule\": {\"monday\": true, \"tuesday\": false, \"wednesday\": true, "
        "\"thursday\": true, \"friday\": true, \"saturday\": false, \"sunday\": false, \"best_time\": \"9am\"}, "
        "\"biggest_opportunity\": \"one specific opportunity\", "
        "\"next_month_priority\": \"the single most important thing\", "
        "\"predicted_reach_increase\": \"15-25% based on data\", "
        "\"strategy_confidence\": 85 } "
        "Base all decisions on actual data patterns. Be specific and actionable. Return only valid JSON."
    )

    nodes = [
        {
            "parameters": {},
            "id": ids["manual"],
            "name": "Manual Trigger",
            "type": "n8n-nodes-base.manualTrigger",
            "typeVersion": 1,
            "position": [240, 300]
        },
        {
            "parameters": {
                "rule": {
                    "interval": [{"field": "cronExpression", "expression": "0 20 * * 0"}]
                }
            },
            "id": ids["schedule"],
            "name": "Schedule Trigger",
            "type": "n8n-nodes-base.scheduleTrigger",
            "typeVersion": 1.2,
            "position": [240, 500]
        },
        {
            "parameters": {
                "method": "GET",
                "url": f"{SUPABASE_URL}/rest/v1/businesses?select=*&is_active=eq.true",
                "sendHeaders": True,
                "headerParameters": supabase_get_headers(),
                "options": {}
            },
            "id": ids["get_businesses"],
            "name": "Get All Businesses",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [460, 300]
        },
        {
            "parameters": {
                "batchSize": 1,
                "options": {}
            },
            "id": ids["loop"],
            "name": "Loop Each Business",
            "type": "n8n-nodes-base.splitInBatches",
            "typeVersion": 3,
            "position": [680, 300]
        },
        {
            "parameters": {
                "method": "GET",
                "url": f"={SUPABASE_URL}/rest/v1/daily_stats?select=*&business_id=eq.{{{{$('Loop Each Business').first().json.id}}}}&order=recorded_at.desc&limit=30",
                "sendHeaders": True,
                "headerParameters": supabase_get_headers(),
                "options": {}
            },
            "id": ids["get_stats"],
            "name": "Get Daily Stats",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [900, 180]
        },
        {
            "parameters": {
                "method": "GET",
                "url": f"={SUPABASE_URL}/rest/v1/generated_content?select=content_theme,status,approved_at,created_at&business_id=eq.{{{{$('Loop Each Business').first().json.id}}}}&order=created_at.desc&limit=30",
                "sendHeaders": True,
                "headerParameters": supabase_get_headers(),
                "options": {}
            },
            "id": ids["get_content"],
            "name": "Get Content Performance",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [900, 340]
        },
        {
            "parameters": {
                "method": "GET",
                "url": f"={SUPABASE_URL}/rest/v1/ad_performance_logs?select=*&business_id=eq.{{{{$('Loop Each Business').first().json.id}}}}&order=logged_at.desc&limit=30",
                "sendHeaders": True,
                "headerParameters": supabase_get_headers(),
                "options": {}
            },
            "id": ids["get_ads"],
            "name": "Get Ad Performance",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [900, 500]
        },
        {
            "parameters": {
                "method": "GET",
                "url": f"={SUPABASE_URL}/rest/v1/competitor_insights?select=*&business_id=eq.{{{{$('Loop Each Business').first().json.id}}}}&order=recorded_at.desc&limit=3",
                "sendHeaders": True,
                "headerParameters": supabase_get_headers(),
                "options": {}
            },
            "id": ids["get_competitors"],
            "name": "Get Competitor Insights",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [900, 660]
        },
        {
            "parameters": {
                "jsCode": (
                    "try {\n"
                    "  const biz = $('Loop Each Business').first().json;\n"
                    "  const stats = $('Get Daily Stats').first().json || [];\n"
                    "  const content = $('Get Content Performance').first().json || [];\n"
                    "  const ads = $('Get Ad Performance').first().json || [];\n"
                    "  const competitors = $('Get Competitor Insights').first().json || [];\n"
                    "\n"
                    "  // Stats summary\n"
                    "  const statsArr = Array.isArray(stats) ? stats : [stats];\n"
                    "  const totalReach = statsArr.reduce((s, r) => s + (r.total_reach || 0), 0);\n"
                    "  const avgReach = statsArr.length ? Math.round(totalReach / statsArr.length) : 0;\n"
                    "  const daily_stats_summary = `${statsArr.length} days of data. Avg daily reach: ${avgReach}. Total reach: ${totalReach}.`;\n"
                    "\n"
                    "  // Content summary\n"
                    "  const contentArr = Array.isArray(content) ? content : [content];\n"
                    "  const approved = contentArr.filter(c => c.status === 'approved').length;\n"
                    "  const approvalRate = contentArr.length ? Math.round(approved / contentArr.length * 100) : 0;\n"
                    "  const themes = [...new Set(contentArr.map(c => c.content_theme).filter(Boolean))];\n"
                    "  const content_performance_summary = `${contentArr.length} content pieces. Approval rate: ${approvalRate}%. Themes used: ${themes.slice(0,5).join(', ')}.`;\n"
                    "\n"
                    "  // Ad performance summary\n"
                    "  const adsArr = Array.isArray(ads) ? ads : [ads];\n"
                    "  const avgRoas = adsArr.length ? (adsArr.reduce((s, a) => s + (a.roas || 0), 0) / adsArr.length).toFixed(2) : 0;\n"
                    "  const avgCtr = adsArr.length ? (adsArr.reduce((s, a) => s + (a.ctr || 0), 0) / adsArr.length).toFixed(2) : 0;\n"
                    "  const totalSpend = adsArr.reduce((s, a) => s + (a.spend || 0), 0).toFixed(2);\n"
                    "  const ad_performance_summary = `${adsArr.length} ad logs. Avg ROAS: ${avgRoas}. Avg CTR: ${avgCtr}%. Total spend: $${totalSpend}.`;\n"
                    "\n"
                    "  // Competitor summary\n"
                    "  const compArr = Array.isArray(competitors) ? competitors : [competitors];\n"
                    "  const competitor_summary = compArr.map(c => `Doing well: ${c.competitor_doing_well || 'n/a'}. Gap: ${c.gap_opportunity || 'n/a'}`).join(' | ') || 'No recent competitor data.';\n"
                    "\n"
                    "  return [{\n"
                    "    json: {\n"
                    "      business_id: biz.id,\n"
                    "      business_name: biz.business_name,\n"
                    "      email: biz.email,\n"
                    "      daily_stats_summary,\n"
                    "      content_performance_summary,\n"
                    "      ad_performance_summary,\n"
                    "      competitor_summary\n"
                    "    }\n"
                    "  }];\n"
                    "} catch(e) {\n"
                    "  return [{json:{error: e.message}}];\n"
                    "}"
                )
            },
            "id": ids["build_prompt"],
            "name": "Build AI Brain Prompt",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1120, 300]
        },
        {
            "parameters": {
                "method": "POST",
                "url": "https://api.anthropic.com/v1/messages",
                "sendHeaders": True,
                "headerParameters": anthropic_headers(),
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": (
                    "={\"model\":\"claude-opus-4-5\",\"max_tokens\":4000,"
                    "\"messages\":[{\"role\":\"user\",\"content\":\""
                    + brain_prompt.replace('"', '\\"')
                    + "\"}]}"
                ),
                "options": {}
            },
            "id": ids["call_claude"],
            "name": "Call Claude Opus - AI Brain",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [1340, 300]
        },
        {
            "parameters": {
                "jsCode": (
                    "try {\n"
                    "  const raw = $input.first().json.content?.[0]?.text || '';\n"
                    "  let c = {};\n"
                    "  try { c = JSON.parse(raw); }\n"
                    "  catch(e) { const m = raw.match(/{[\\s\\S]*}/); if(m) try { c = JSON.parse(m[0]); } catch(e2) {} }\n"
                    "  const biz = $('Loop Each Business').first().json;\n"
                    "  const prompt_data = $('Build AI Brain Prompt').first().json;\n"
                    "  return [{\n"
                    "    json: {\n"
                    "      business_id: biz.id,\n"
                    "      business_name: biz.business_name,\n"
                    "      email: biz.email,\n"
                    "      decisions: c,\n"
                    "      decisions_str: JSON.stringify(c)\n"
                    "    }\n"
                    "  }];\n"
                    "} catch(e) {\n"
                    "  return [{json:{error: e.message}}];\n"
                    "}"
                )
            },
            "id": ids["parse_decisions"],
            "name": "Parse AI Decisions",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1560, 300]
        },
        {
            "parameters": {
                "method": "PATCH",
                "url": f"={SUPABASE_URL}/rest/v1/businesses?id=eq.{{{{$json.business_id}}}}",
                "sendHeaders": True,
                "headerParameters": supabase_patch_headers(),
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={\"marketing_strategy\":\"{{$json.decisions_str}}\"}",
                "options": {}
            },
            "id": ids["save_decisions"],
            "name": "Save AI Brain Decisions",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [1780, 300]
        },
        {
            "parameters": {
                "sendTo": "={{ $json.email }}",
                "subject": "=Your AI Brain Just Made 5 Decisions for {{ $json.business_name }}",
                "emailType": "html",
                "message": (
                    "=<html><body style='font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;'>"
                    "<h1 style='color:#1a73e8;'>Your AI Brain Weekly Report</h1>"
                    "<p>Hi {{ $json.business_name }},</p>"
                    "<p>Your AI brain has analyzed all your marketing data and made 5 strategic decisions for next month:</p>"
                    "<hr/>"
                    "<h3 style='color:#34a853;'>1. Content Focus</h3>"
                    "<p><strong>Focus on:</strong> {{ $json.decisions.content_themes_to_focus?.join(', ') }}</p>"
                    "<p><strong>Avoid:</strong> {{ $json.decisions.content_themes_to_avoid?.join(', ') }}</p>"
                    "<h3 style='color:#34a853;'>2. Best Audiences</h3>"
                    "<p>{{ $json.decisions.best_performing_audiences }}</p>"
                    "<h3 style='color:#34a853;'>3. Competitor Counter-Strategy</h3>"
                    "<p>{{ $json.decisions.competitor_counter_strategy }}</p>"
                    "<h3 style='color:#34a853;'>4. Biggest Opportunity</h3>"
                    "<p>{{ $json.decisions.biggest_opportunity }}</p>"
                    "<h3 style='color:#34a853;'>5. Next Month Priority</h3>"
                    "<p><strong>{{ $json.decisions.next_month_priority }}</strong></p>"
                    "<hr/>"
                    "<p><strong>Predicted Reach Increase:</strong> {{ $json.decisions.predicted_reach_increase }}</p>"
                    "<p><strong>AI Confidence:</strong> {{ $json.decisions.strategy_confidence }}%</p>"
                    "<p style='color:#666;font-size:14px;'>Log in to <a href='https://maroa-ai-marketing-automator.lovable.app'>maroa.ai</a> to see your full analytics.</p>"
                    "</body></html>"
                ),
                "options": {
                    "appendAttribution": False
                }
            },
            "credentials": GMAIL_CRED,
            "id": ids["send_email"],
            "name": "Send AI Brain Email",
            "type": "n8n-nodes-base.gmail",
            "typeVersion": 2.1,
            "position": [2000, 300]
        }
    ]

    connections = {
        "Manual Trigger": {"main": [[{"node": "Get All Businesses", "type": "main", "index": 0}]]},
        "Schedule Trigger": {"main": [[{"node": "Get All Businesses", "type": "main", "index": 0}]]},
        "Get All Businesses": {"main": [[{"node": "Loop Each Business", "type": "main", "index": 0}]]},
        "Loop Each Business": {
            "main": [
                [{"node": "Get Daily Stats", "type": "main", "index": 0}],
                []
            ]
        },
        "Get Daily Stats": {"main": [[{"node": "Get Content Performance", "type": "main", "index": 0}]]},
        "Get Content Performance": {"main": [[{"node": "Get Ad Performance", "type": "main", "index": 0}]]},
        "Get Ad Performance": {"main": [[{"node": "Get Competitor Insights", "type": "main", "index": 0}]]},
        "Get Competitor Insights": {"main": [[{"node": "Build AI Brain Prompt", "type": "main", "index": 0}]]},
        "Build AI Brain Prompt": {"main": [[{"node": "Call Claude Opus - AI Brain", "type": "main", "index": 0}]]},
        "Call Claude Opus - AI Brain": {"main": [[{"node": "Parse AI Decisions", "type": "main", "index": 0}]]},
        "Parse AI Decisions": {"main": [[{"node": "Save AI Brain Decisions", "type": "main", "index": 0}]]},
        "Save AI Brain Decisions": {"main": [[{"node": "Send AI Brain Email", "type": "main", "index": 0}]]},
        "Send AI Brain Email": {"main": [[{"node": "Loop Each Business", "type": "main", "index": 0}]]}
    }

    return {
        "name": "WF30 - Central AI Brain",
        "nodes": nodes,
        "connections": connections,
        "active": False,
        "settings": {"executionOrder": "v1"},
        "tags": []
    }


# ─────────────────────────────────────────────────────────────────────────────
# WF31 – LANDING PAGE GENERATOR
# ─────────────────────────────────────────────────────────────────────────────
def build_wf31():
    ids = {k: uid() for k in [
        "manual", "webhook", "extract", "get_biz", "get_campaign",
        "call_claude", "parse", "save_page", "send_email"
    ]}

    lp_prompt = (
        "You are a conversion rate optimization expert. Create a high-converting landing page for "
        "{{ $('Get Business').first().json.business_name }} "
        "({{ $('Get Business').first().json.industry }}) in {{ $('Get Business').first().json.location }}. "
        "This landing page is for the following ad campaign: "
        "{{ $('Get Campaign').first().json.last_decision }} - {{ $('Get Campaign').first().json.last_decision_reason }}. "
        "Brand tone: {{ $('Get Business').first().json.brand_tone }}. "
        "Marketing goal: {{ $('Get Business').first().json.marketing_goal }}. "
        "Target audience: {{ $('Get Business').first().json.target_audience }}. "
        "Return ONLY valid JSON: "
        "{ \"headline\": \"main H1 headline (powerful, benefit-focused, max 10 words)\", "
        "\"subheadline\": \"supporting line below headline (max 20 words)\", "
        "\"benefit_1\": \"first key benefit (start with action verb)\", "
        "\"benefit_2\": \"second key benefit\", "
        "\"benefit_3\": \"third key benefit\", "
        "\"social_proof\": \"testimonial or social proof element (realistic for this business type)\", "
        "\"cta_button_text\": \"button text (max 5 words, action-oriented)\", "
        "\"urgency_element\": \"urgency or scarcity element (e.g. Limited spots, This week only)\", "
        "\"form_fields\": [\"First Name\", \"Email\", \"Phone (optional)\"], "
        "\"trust_badges\": [\"Badge 1\", \"Badge 2\", \"Badge 3\"], "
        "\"full_page_copy\": \"complete landing page body copy in HTML (200-300 words, include the headline, subheadline, benefits, social proof, CTA — use clean HTML with inline styles, make it look professional)\" } "
        "Return only valid JSON, no markdown."
    )

    nodes = [
        {
            "parameters": {},
            "id": ids["manual"],
            "name": "Manual Trigger",
            "type": "n8n-nodes-base.manualTrigger",
            "typeVersion": 1,
            "position": [240, 300]
        },
        {
            "parameters": {
                "httpMethod": "POST",
                "path": "generate-landing-page",
                "options": {},
                "responseMode": "onReceived"
            },
            "id": ids["webhook"],
            "name": "Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [240, 500]
        },
        {
            "parameters": {
                "jsCode": (
                    "try {\n"
                    "  const items = $input.all();\n"
                    "  const results = [];\n"
                    "  for (const item of items) {\n"
                    "    const body = item.json.body || item.json;\n"
                    "    results.push({json: {\n"
                    "      business_id: body.business_id || '',\n"
                    "      campaign_id: body.campaign_id || '',\n"
                    "      email: body.email || '',\n"
                    "      business_name: body.business_name || ''\n"
                    "    }});\n"
                    "  }\n"
                    "  return results;\n"
                    "} catch(e) {\n"
                    "  return [{json:{error: e.message}}];\n"
                    "}"
                )
            },
            "id": ids["extract"],
            "name": "Extract Data",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [460, 300]
        },
        {
            "parameters": {
                "method": "GET",
                "url": f"={SUPABASE_URL}/rest/v1/businesses?select=*&id=eq.{{{{$('Extract Data').first().json.business_id}}}}",
                "sendHeaders": True,
                "headerParameters": supabase_get_headers(),
                "options": {}
            },
            "id": ids["get_biz"],
            "name": "Get Business",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [680, 180]
        },
        {
            "parameters": {
                "method": "GET",
                "url": f"={SUPABASE_URL}/rest/v1/ad_campaigns?select=*&id=eq.{{{{$('Extract Data').first().json.campaign_id}}}}",
                "sendHeaders": True,
                "headerParameters": supabase_get_headers(),
                "options": {}
            },
            "id": ids["get_campaign"],
            "name": "Get Campaign",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [680, 420]
        },
        {
            "parameters": {
                "method": "POST",
                "url": "https://api.anthropic.com/v1/messages",
                "sendHeaders": True,
                "headerParameters": anthropic_headers(),
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": (
                    "={\"model\":\"claude-sonnet-4-5\",\"max_tokens\":3000,"
                    "\"messages\":[{\"role\":\"user\",\"content\":\""
                    + lp_prompt.replace('"', '\\"').replace('\n', '\\n')
                    + "\"}]}"
                ),
                "options": {}
            },
            "id": ids["call_claude"],
            "name": "Call Claude - Landing Page Creator",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [900, 300]
        },
        {
            "parameters": {
                "jsCode": (
                    "try {\n"
                    "  const raw = $input.first().json.content?.[0]?.text || '';\n"
                    "  let c = {};\n"
                    "  try { c = JSON.parse(raw); }\n"
                    "  catch(e) { const m = raw.match(/{[\\s\\S]*}/); if(m) try { c = JSON.parse(m[0]); } catch(e2) {} }\n"
                    "  const extract = $('Extract Data').first().json;\n"
                    "  return [{\n"
                    "    json: {\n"
                    "      business_id: extract.business_id,\n"
                    "      campaign_id: extract.campaign_id,\n"
                    "      email: extract.email,\n"
                    "      business_name: extract.business_name,\n"
                    "      headline: c.headline || '',\n"
                    "      subheadline: c.subheadline || '',\n"
                    "      benefit_1: c.benefit_1 || '',\n"
                    "      benefit_2: c.benefit_2 || '',\n"
                    "      benefit_3: c.benefit_3 || '',\n"
                    "      social_proof: c.social_proof || '',\n"
                    "      cta_button_text: c.cta_button_text || '',\n"
                    "      urgency_element: c.urgency_element || '',\n"
                    "      form_fields: c.form_fields || [],\n"
                    "      trust_badges: c.trust_badges || [],\n"
                    "      full_page_copy: c.full_page_copy || ''\n"
                    "    }\n"
                    "  }];\n"
                    "} catch(e) {\n"
                    "  return [{json:{error: e.message}}];\n"
                    "}"
                )
            },
            "id": ids["parse"],
            "name": "Parse Landing Page",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1120, 300]
        },
        {
            "parameters": {
                "method": "POST",
                "url": f"{SUPABASE_URL}/rest/v1/landing_pages",
                "sendHeaders": True,
                "headerParameters": supabase_post_headers(),
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": (
                    "={\"business_id\":\"{{$json.business_id}}\","
                    "\"campaign_id\":\"{{$json.campaign_id}}\","
                    "\"headline\":\"{{$json.headline}}\","
                    "\"subheadline\":\"{{$json.subheadline}}\","
                    "\"benefit_1\":\"{{$json.benefit_1}}\","
                    "\"benefit_2\":\"{{$json.benefit_2}}\","
                    "\"benefit_3\":\"{{$json.benefit_3}}\","
                    "\"social_proof\":\"{{$json.social_proof}}\","
                    "\"cta_button_text\":\"{{$json.cta_button_text}}\","
                    "\"urgency_element\":\"{{$json.urgency_element}}\","
                    "\"full_page_copy\":\"{{$json.full_page_copy}}\","
                    "\"status\":\"draft\"}"
                ),
                "options": {}
            },
            "id": ids["save_page"],
            "name": "Save Landing Page",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.1,
            "position": [1340, 300]
        },
        {
            "parameters": {
                "sendTo": "={{ $('Extract Data').first().json.email }}",
                "subject": "=Your Landing Page Is Ready, {{ $('Parse Landing Page').first().json.business_name }}!",
                "emailType": "html",
                "message": (
                    "=<html><body style='font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;'>"
                    "<h1 style='color:#1a73e8;'>Your Landing Page Is Ready!</h1>"
                    "<p>Hi {{ $('Parse Landing Page').first().json.business_name }},</p>"
                    "<p>We've generated a high-converting landing page for your ad campaign. Here are all the elements:</p>"
                    "<hr/>"
                    "<h2 style='color:#34a853;'>Headline</h2>"
                    "<p style='font-size:22px;font-weight:bold;'>{{ $('Parse Landing Page').first().json.headline }}</p>"
                    "<h3>Subheadline</h3>"
                    "<p>{{ $('Parse Landing Page').first().json.subheadline }}</p>"
                    "<h3>Key Benefits</h3>"
                    "<ul>"
                    "<li>{{ $('Parse Landing Page').first().json.benefit_1 }}</li>"
                    "<li>{{ $('Parse Landing Page').first().json.benefit_2 }}</li>"
                    "<li>{{ $('Parse Landing Page').first().json.benefit_3 }}</li>"
                    "</ul>"
                    "<h3>Social Proof</h3>"
                    "<p><em>\"{{ $('Parse Landing Page').first().json.social_proof }}\"</em></p>"
                    "<h3>CTA Button</h3>"
                    "<p><strong style='background:#1a73e8;color:white;padding:10px 20px;border-radius:4px;'>{{ $('Parse Landing Page').first().json.cta_button_text }}</strong></p>"
                    "<h3>Urgency Element</h3>"
                    "<p>{{ $('Parse Landing Page').first().json.urgency_element }}</p>"
                    "<h3>Form Fields</h3>"
                    "<p>{{ $('Parse Landing Page').first().json.form_fields?.join(', ') }}</p>"
                    "<h3>Trust Badges</h3>"
                    "<p>{{ $('Parse Landing Page').first().json.trust_badges?.join(' | ') }}</p>"
                    "<hr/>"
                    "<h2>Full Page HTML</h2>"
                    "<p>Copy and paste the HTML below into your website builder:</p>"
                    "<div style='background:#f5f5f5;padding:15px;border-radius:4px;font-family:monospace;font-size:12px;white-space:pre-wrap;overflow-x:auto;'>{{ $('Parse Landing Page').first().json.full_page_copy }}</div>"
                    "<hr/>"
                    "<p style='color:#666;font-size:14px;'>Log in to <a href='https://maroa-ai-marketing-automator.lovable.app'>maroa.ai</a> to manage all your landing pages.</p>"
                    "</body></html>"
                ),
                "options": {
                    "appendAttribution": False
                }
            },
            "credentials": GMAIL_CRED,
            "id": ids["send_email"],
            "name": "Send Landing Page Email",
            "type": "n8n-nodes-base.gmail",
            "typeVersion": 2.1,
            "position": [1560, 300]
        }
    ]

    connections = {
        "Manual Trigger": {"main": [[{"node": "Extract Data", "type": "main", "index": 0}]]},
        "Webhook": {"main": [[{"node": "Extract Data", "type": "main", "index": 0}]]},
        "Extract Data": {"main": [[
            {"node": "Get Business", "type": "main", "index": 0},
            {"node": "Get Campaign", "type": "main", "index": 0}
        ]]},
        "Get Business": {"main": [[{"node": "Call Claude - Landing Page Creator", "type": "main", "index": 0}]]},
        "Get Campaign": {"main": [[{"node": "Call Claude - Landing Page Creator", "type": "main", "index": 0}]]},
        "Call Claude - Landing Page Creator": {"main": [[{"node": "Parse Landing Page", "type": "main", "index": 0}]]},
        "Parse Landing Page": {"main": [[{"node": "Save Landing Page", "type": "main", "index": 0}]]},
        "Save Landing Page": {"main": [[{"node": "Send Landing Page Email", "type": "main", "index": 0}]]}
    }

    return {
        "name": "WF31 - Landing Page Generator",
        "nodes": nodes,
        "connections": connections,
        "active": False,
        "settings": {"executionOrder": "v1"},
        "tags": []
    }


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────
def main():
    workflows = [
        ("29_ad_campaign_creator.json", build_wf29()),
        ("30_central_ai_brain.json", build_wf30()),
        ("31_landing_page_generator.json", build_wf31()),
    ]

    for filename, wf in workflows:
        filepath = os.path.join(OUTPUT_DIR, filename)
        # Validate JSON round-trip
        try:
            json_str = json.dumps(wf, indent=2, ensure_ascii=False)
            parsed = json.loads(json_str)  # validate it parses back cleanly
        except Exception as e:
            print(f"ERROR: {filename} failed JSON validation: {e}")
            continue

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(json_str)

        node_count = len(parsed["nodes"])
        conn_count = len(parsed["connections"])
        print(f"OK  {filename}")
        print(f"    nodes={node_count}, connections={conn_count}, active={parsed['active']}")
        print(f"    saved to {filepath}")
        print()

    print("All 3 workflow files created successfully.")


if __name__ == "__main__":
    main()
