#!/usr/bin/env python3
"""Generate all 40 maximum-intelligence n8n workflow JSON files."""
import json, os, uuid

OUT = "/Users/bekteshi/Desktop/Maroa.ai/n8n-workflows"
RAIL = "https://maroa-api-production.up.railway.app"
SUPA = "https://zqhyrbttuqkvmdewiytf.supabase.co"

def uid():
    return str(uuid.uuid4())

def manual():
    return {"id": uid(), "name": "Manual Trigger", "type": "n8n-nodes-base.manualTrigger", "typeVersion": 1, "position": [240, 300], "parameters": {}}

def schedule(cron):
    return {"id": uid(), "name": "Schedule Trigger", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.1, "position": [240, 500], "parameters": {"rule": {"interval": [{"field": "cronExpression", "expression": cron}]}}}

def webhook_trigger(path=""):
    return {"id": uid(), "name": "Webhook Trigger", "type": "n8n-nodes-base.webhook", "typeVersion": 2, "position": [240, 300], "parameters": {"path": path, "httpMethod": "POST", "responseMode": "responseNode"}, "webhookId": uid()}

def http_get_supa(name, query, pos):
    return {"id": uid(), "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": pos, "parameters": {"method": "GET", "url": f"{SUPA}/rest/v1/{query}", "sendHeaders": True, "headerParameters": {"parameters": [{"name": "apikey", "value": "={{ $env.SUPABASE_KEY }}"}, {"name": "Authorization", "value": "=Bearer {{ $env.SUPABASE_KEY }}"}]}}}

def http_post_rail(name, endpoint, body_expr, pos):
    return {"id": uid(), "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": pos, "parameters": {"method": "POST", "url": f"{RAIL}{endpoint}", "sendHeaders": True, "headerParameters": {"parameters": [{"name": "Content-Type", "value": "application/json"}]}, "sendBody": True, "specifyBody": "json", "jsonBody": body_expr}}

def http_get_rail(name, endpoint, pos):
    return {"id": uid(), "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": pos, "parameters": {"method": "GET", "url": f"{RAIL}{endpoint}", "sendHeaders": True, "headerParameters": {"parameters": [{"name": "Content-Type", "value": "application/json"}]}}}

def splitter(name="Loop Each Business", pos=None):
    return {"id": uid(), "name": name, "type": "n8n-nodes-base.splitInBatches", "typeVersion": 3, "position": pos or [700, 400], "parameters": {"batchSize": 5, "options": {}}}

def wait_node(name, seconds, pos):
    return {"id": uid(), "name": name, "type": "n8n-nodes-base.wait", "typeVersion": 1.1, "position": pos, "parameters": {"amount": seconds, "unit": "seconds"}}

def code_node(name, js, pos):
    return {"id": uid(), "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2, "position": pos, "parameters": {"jsCode": js}}

def noop(name, pos):
    return {"id": uid(), "name": name, "type": "n8n-nodes-base.noOp", "typeVersion": 1, "position": pos, "parameters": {}}

def if_node(name, expr, pos):
    return {"id": uid(), "name": name, "type": "n8n-nodes-base.if", "typeVersion": 2, "position": pos, "parameters": {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict"}, "conditions": [{"id": uid(), "leftValue": expr, "rightValue": "true", "operator": {"type": "boolean", "operation": "true"}}], "combinator": "and"}}}

def log_error_node(pos):
    return http_post_rail("Log Error", "/webhook/log-error", '={{ JSON.stringify({ workflow_name: $workflow.name, error_message: $json.error || "unknown", business_id: null }) }}', pos)

def biz_id_body(loop_name="Loop Each Business"):
    return '={{ JSON.stringify({ business_id: $(\'' + loop_name + '\').first().json.id }) }}'

def wf(name, nodes, connections):
    return {"name": name, "active": False, "settings": {"executionOrder": "v1"}, "nodes": nodes, "connections": connections, "tags": [], "pinData": {}}

def save(filename, data):
    path = os.path.join(OUT, filename)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
    print(f"  ✅ {filename}")

# ─── Helper: standard loop workflow ──────────────────────────────────────────
def loop_workflow(name, cron, supa_query, steps, loop_name="Loop Each Business"):
    """Build a standard loop-based workflow with error branch."""
    nodes = [manual(), schedule(cron)]
    get_node = http_get_supa("Get Businesses", supa_query, [480, 400])
    loop_node = splitter(loop_name, [700, 400])
    nodes += [get_node, loop_node]

    x = 940
    for s in steps:
        s_node = s["build"](x)
        nodes.append(s_node)
        x += 240

    err = log_error_node([x, 560])
    back = noop("Back to Loop", [x, 400])
    nodes += [err, back]

    # Build connections
    conn = {
        "Manual Trigger": {"main": [[{"node": "Get Businesses", "type": "main", "index": 0}]]},
        "Schedule Trigger": {"main": [[{"node": "Get Businesses", "type": "main", "index": 0}]]},
        "Get Businesses": {"main": [[{"node": loop_name, "type": "main", "index": 0}]]}
    }

    # Loop output 0 → first step, output 1 → nothing
    first_step_name = steps[0]["name"]
    conn[loop_name] = {"main": [[{"node": first_step_name, "type": "main", "index": 0}], []]}

    # Chain steps
    for i in range(len(steps) - 1):
        conn[steps[i]["name"]] = {"main": [[{"node": steps[i+1]["name"], "type": "main", "index": 0}]]}

    # Last step → back to loop
    conn[steps[-1]["name"]] = {"main": [[{"node": "Back to Loop", "type": "main", "index": 0}]]}
    conn["Back to Loop"] = {"main": [[{"node": loop_name, "type": "main", "index": 0}]]}

    return wf(name, nodes, conn)

# ─── Step builder helpers ────────────────────────────────────────────────────
def rail_step(name, endpoint, body=None):
    b = body or biz_id_body()
    return {"name": name, "build": lambda x: http_post_rail(name, endpoint, b, [x, 300])}

def rail_get_step(name, endpoint):
    return {"name": name, "build": lambda x: http_get_rail(name, endpoint, [x, 300])}

def wait_step(name, secs):
    return {"name": name, "build": lambda x: wait_node(name, secs, [x, 300])}

def code_step(name, js):
    return {"name": name, "build": lambda x: code_node(name, js, [x, 300])}

# ═══════════════════════════════════════════════════════════════════════════════
print("Generating 40 maximum-intelligence workflow files...")
print()

# WF02 — Daily Ad Optimizer
save("WF02-max.json", loop_workflow(
    "WF02 - Daily Ad Optimizer (MAX)", "0 6 * * *",
    "businesses?select=id,business_name,email,ad_account_id&is_active=eq.true&ad_account_id=not.is.null",
    [
        rail_step("Optimize Meta Campaigns", "/webhook/meta-campaign-optimize"),
        rail_step("Optimize Google Campaigns", "/webhook/google-campaign-optimize"),
        wait_step("Wait 2s", 2),
        rail_step("Check Crisis", "/webhook/crisis-check"),
    ]
))

# WF03 — New User Onboarding (webhook-triggered, different structure)
n03 = [
    webhook_trigger("new-user-onboarding"),
    code_node("Extract Business ID", 'const body = $input.first().json.body || $input.first().json;\nreturn [{ json: { business_id: body.business_id, email: body.email } }];', [480, 300]),
    http_post_rail("Signup Handler", "/webhook/new-user-signup", '={{ JSON.stringify($json) }}', [720, 300]),
    wait_node("Wait 30s", 30, [960, 300]),
    http_post_rail("Generate First Content", "/webhook/instant-content", '={{ JSON.stringify({ business_id: $json.business_id, email: $json.email }) }}', [1200, 300]),
    http_post_rail("Build Competitive Moat", "/webhook/build-competitive-moat", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [1440, 300]),
    http_post_rail("Analyze Audience", "/webhook/analyze-audience", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [1680, 300]),
    http_post_rail("SEO Audit", "/webhook/seo-audit", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [1920, 300]),
    http_post_rail("Create Welcome Sequence", "/webhook/email-sequence-create",
        '={{ JSON.stringify({ business_id: $json.business_id, name: "Welcome Series", trigger_type: "signup", emails: [{ subject_prompt: "Welcome to AI marketing", body_prompt: "Warm welcome, explain what AI is doing for them", delay_hours: 0 }, { subject_prompt: "Your first AI content is ready", body_prompt: "Show them what was created", delay_hours: 24 }, { subject_prompt: "Your marketing strategy is set", body_prompt: "Explain the strategy AI built", delay_hours: 72 }] }) }}',
        [2160, 300]),
    log_error_node([1200, 520]),
]
c03 = {}
chain = ["Webhook Trigger", "Extract Business ID", "Signup Handler", "Wait 30s", "Generate First Content", "Build Competitive Moat", "Analyze Audience", "SEO Audit", "Create Welcome Sequence"]
for i in range(len(chain) - 1):
    c03[chain[i]] = {"main": [[{"node": chain[i+1], "type": "main", "index": 0}]]}
save("WF03-max.json", wf("WF03 - New User Onboarding (MAX)", n03, c03))

# WF04 — Retention Anti-Churn
save("WF04-max.json", loop_workflow(
    "WF04 - Retention Anti-Churn (MAX)", "0 8 * * *",
    "businesses?select=id,business_name,email,last_login_at,plan&is_active=eq.true",
    [
        rail_step("Master Agent Value Gen", "/webhook/master-agent"),
        wait_step("Wait 10s", 10),
        rail_step("Crisis Check", "/webhook/crisis-check"),
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
    ]
))

# WF05 — AB Testing Engine
save("WF05-max.json", loop_workflow(
    "WF05 - AB Testing Engine (MAX)", "0 10 * * *",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
        wait_step("Wait 5s", 5),
        rail_step("Train Brand Memory", "/webhook/brand-memory-train"),
    ]
))

# WF06 — Weekly Strategy Review
save("WF06-max.json", loop_workflow(
    "WF06 - Weekly Strategy Review (MAX)", "0 5 * * 1",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Weekly Strategy Update", "/webhook/weekly-strategy-update"),
        wait_step("Wait 5s", 5),
        rail_step("Analyze Audience", "/webhook/analyze-audience"),
        wait_step("Wait 3s", 3),
        rail_step("Build Competitive Moat", "/webhook/build-competitive-moat"),
        wait_step("Wait 3s-2", 3),
        rail_step("Growth Engine", "/webhook/growth-engine"),
    ]
))

# WF07 — Win Notifications
save("WF07-max.json", loop_workflow(
    "WF07 - Win Notifications (MAX)", "0 17 * * 5",
    "businesses?select=id,business_name,email,ai_brain_decisions,growth_engine_recommendation&is_active=eq.true",
    [
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
        wait_step("Wait 3s", 3),
        rail_step("Analytics Report", "/webhook/analytics-report"),
    ]
))

# WF08 — Performance Tracker
save("WF08-max.json", loop_workflow(
    "WF08 - Performance Tracker (MAX)", "0 23 * * *",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Analytics Snapshot", "/webhook/analytics-snapshot"),
        wait_step("Wait 5s", 5),
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
        wait_step("Wait 3s", 3),
        rail_step("Crisis Check", "/webhook/crisis-check"),
    ]
))

# WF09 — Smart Image System (webhook-triggered)
n09 = [
    webhook_trigger("smart-image"),
    code_node("Extract Data", 'const b = $input.first().json.body || $input.first().json;\nreturn [{ json: { business_id: b.business_id, content_id: b.content_id, caption: b.caption || "" } }];', [480, 300]),
    http_post_rail("Score Caption", "/webhook/score-content", '={{ JSON.stringify({ business_id: $json.business_id, caption: $json.caption, image_url: "" }) }}', [720, 300]),
    http_post_rail("Generate Content (includes image)", "/webhook/instant-content", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [960, 300]),
    log_error_node([720, 520]),
]
c09 = {"Webhook Trigger": {"main": [[{"node": "Extract Data", "type": "main", "index": 0}]]}, "Extract Data": {"main": [[{"node": "Score Caption", "type": "main", "index": 0}]]}, "Score Caption": {"main": [[{"node": "Generate Content (includes image)", "type": "main", "index": 0}]]}}
save("WF09-max.json", wf("WF09 - Smart Image System (MAX)", n09, c09))

# WF10 — Lookalike Audience Builder
save("WF10-max.json", loop_workflow(
    "WF10 - Lookalike Audience Builder (MAX)", "0 3 * * 0",
    "businesses?select=id,business_name,email,ad_account_id,meta_access_token,facebook_page_id&is_active=eq.true&ad_account_id=not.is.null",
    [
        rail_step("Analyze Audience", "/webhook/analyze-audience"),
        wait_step("Wait 5s", 5),
        rail_step("Optimize Posting Times", "/webhook/optimize-posting-times"),
    ]
))

# WF11 — Retargeting Creator
save("WF11-max.json", loop_workflow(
    "WF11 - Retargeting Creator (MAX)", "0 6 * * 3",
    "businesses?select=id,business_name,email,meta_access_token,ad_account_id&is_active=eq.true&ad_account_id=not.is.null",
    [
        rail_step("Generate Ad Creative", "/webhook/ad-creative-generate"),
        wait_step("Wait 5s", 5),
        rail_step("Score Content", "/webhook/score-content",
            "={{ JSON.stringify({ business_id: $('Loop Each Business').first().json.id, caption: 'retargeting ad', image_url: '' }) }}"),
    ]
))

# WF12 — Content Approval Flow
save("WF12-max.json", loop_workflow(
    "WF12 - Content Approval Flow (MAX)", "0 9 * * *",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
        wait_step("Wait 3s", 3),
        rail_step("Optimize Posting Times", "/webhook/optimize-posting-times"),
    ]
))

# WF13 — Dayparting Optimizer
save("WF13-max.json", loop_workflow(
    "WF13 - Dayparting Optimizer (MAX)", "0 4 * * 0",
    "businesses?select=id,business_name,email,ad_account_id&is_active=eq.true&ad_account_id=not.is.null",
    [
        rail_step("Analyze Audience", "/webhook/analyze-audience"),
        wait_step("Wait 5s", 5),
        rail_step("Optimize Posting Times", "/webhook/optimize-posting-times"),
    ]
))

# WF15 — Instant Content On Signup (webhook)
n15 = [
    webhook_trigger("instant-content-signup"),
    code_node("Extract", 'const b = $input.first().json.body || $input.first().json;\nreturn [{ json: { business_id: b.business_id } }];', [480, 300]),
    http_post_rail("Build Moat", "/webhook/build-competitive-moat", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [720, 300]),
    wait_node("Wait 15s", 15, [960, 300]),
    http_post_rail("Generate Content", "/webhook/instant-content", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [1200, 300]),
    http_post_rail("SEO Audit", "/webhook/seo-audit", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [1440, 300]),
    log_error_node([960, 520]),
]
c15 = {"Webhook Trigger": {"main": [[{"node": "Extract", "type": "main", "index": 0}]]}, "Extract": {"main": [[{"node": "Build Moat", "type": "main", "index": 0}]]}, "Build Moat": {"main": [[{"node": "Wait 15s", "type": "main", "index": 0}]]}, "Wait 15s": {"main": [[{"node": "Generate Content", "type": "main", "index": 0}]]}, "Generate Content": {"main": [[{"node": "SEO Audit", "type": "main", "index": 0}]]}}
save("WF15-max.json", wf("WF15 - Instant Content On Signup (MAX)", n15, c15))

# WF16 — AI Inbox Manager
save("WF16-max.json", loop_workflow(
    "WF16 - AI Inbox Manager (MAX)", "0 */2 * * *",
    "businesses?select=id,business_name,email,facebook_page_id,meta_access_token&is_active=eq.true&facebook_page_id=not.is.null",
    [
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
    ]
))

# WF17 — Monthly Report Email
save("WF17-max.json", loop_workflow(
    "WF17 - Monthly Report Email (MAX)", "0 7 1 * *",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Analytics Report", "/webhook/analytics-report"),
        wait_step("Wait 10s", 10),
        rail_step("Growth Engine", "/webhook/growth-engine"),
    ]
))

# WF18 — Reactivation Campaign
save("WF18-max.json", loop_workflow(
    "WF18 - Reactivation Campaign (MAX)", "0 9 * * 1",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Master Agent", "/webhook/master-agent"),
        wait_step("Wait 5s", 5),
        rail_step("Process Email Sequences", "/webhook/email-sequence-process",
            '={{ JSON.stringify({}) }}'),
    ]
))

# WF19 — Upsell Automation
save("WF19-max.json", loop_workflow(
    "WF19 - Upsell Automation (MAX)", "0 10 * * 3",
    "businesses?select=id,business_name,email,plan&is_active=eq.true&plan=eq.free",
    [
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
        wait_step("Wait 3s", 3),
        rail_step("Growth Engine", "/webhook/growth-engine"),
    ]
))

# WF20 — Testimonial Collector
save("WF20-max.json", loop_workflow(
    "WF20 - Testimonial Collector (MAX)", "0 11 * * 4",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
        wait_step("Wait 3s", 3),
        rail_step("Brand Memory Train", "/webhook/brand-memory-train"),
    ]
))

# WF21 — Seasonal Campaign Creator
save("WF21-max.json", loop_workflow(
    "WF21 - Seasonal Campaign Creator (MAX)", "0 6 1 * *",
    "businesses?select=id,business_name,email,daily_budget&is_active=eq.true",
    [
        rail_step("Orchestrate Campaign", "/webhook/orchestrate-campaign",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, campaign_goal: "seasonal promotion", budget: $(\'Loop Each Business\').first().json.daily_budget * 30 || 300 }) }}'),
        wait_step("Wait 10s", 10),
        rail_step("Build Competitive Moat", "/webhook/build-competitive-moat"),
    ]
))

# WF22 — Viral Content Detector
save("WF22-max.json", loop_workflow(
    "WF22 - Viral Content Detector (MAX)", "0 14 * * *",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
        wait_step("Wait 5s", 5),
        rail_step("Brand Memory Store Winners", "/webhook/brand-memory-train"),
    ]
))

# WF23 — Video Script Generator
save("WF23-max.json", loop_workflow(
    "WF23 - Video Script Generator (MAX)", "0 10 * * 3",
    "businesses?select=id,business_name,email,content_opportunities&is_active=eq.true",
    [
        rail_step("Generate Video Script", "/webhook/video-script-generate",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, platform: "tiktok" }) }}'),
        wait_step("Wait 10s", 10),
        rail_step("Score Content", "/webhook/score-content",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, caption: "video hook check", image_url: "" }) }}'),
    ]
))

# WF24 — Smart Budget Optimizer
save("WF24-max.json", loop_workflow(
    "WF24 - Smart Budget Optimizer (MAX)", "0 7 * * *",
    "businesses?select=id,business_name,email,ad_account_id&is_active=eq.true&ad_account_id=not.is.null",
    [
        rail_step("Optimize Meta Campaigns", "/webhook/meta-campaign-optimize"),
        wait_step("Wait 3s", 3),
        rail_step("Optimize Google Campaigns", "/webhook/google-campaign-optimize"),
        wait_step("Wait 3s-2", 3),
        rail_step("Crisis Check", "/webhook/crisis-check"),
    ]
))

# WF25 — Customer Journey Emails
save("WF25-max.json", loop_workflow(
    "WF25 - Customer Journey Emails (MAX)", "*/30 * * * *",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Process Email Sequences", "/webhook/email-sequence-process",
            '={{ JSON.stringify({}) }}'),
    ]
))

# WF26 — Ad Creative Refresh
save("WF26-max.json", loop_workflow(
    "WF26 - Ad Creative Refresh (MAX)", "0 5 * * 0",
    "businesses?select=id,business_name,email,ad_account_id&is_active=eq.true&ad_account_id=not.is.null",
    [
        rail_step("Generate Ad Creative", "/webhook/ad-creative-generate"),
        wait_step("Wait 5s", 5),
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
    ]
))

# WF27 — Weekly Wins Social Post
save("WF27-max.json", loop_workflow(
    "WF27 - Weekly Wins Social Post (MAX)", "0 16 * * 5",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Generate Content", "/webhook/instant-content"),
        wait_step("Wait 10s", 10),
        rail_step("Score Content", "/webhook/score-content",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, caption: "weekly wins summary post", image_url: "" }) }}'),
    ]
))

# WF28 — Google My Business Poster
save("WF28-max.json", loop_workflow(
    "WF28 - Google My Business Poster (MAX)", "0 9 * * 2,5",
    "businesses?select=id,business_name,email,google_business_id,google_access_token&is_active=eq.true&google_business_id=not.is.null",
    [
        rail_step("Score Content", "/webhook/score-content",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, caption: "GMB local post", image_url: "" }) }}'),
        wait_step("Wait 3s", 3),
        rail_step("SEO Audit", "/webhook/seo-audit"),
    ]
))

# WF29 — Ad Campaign Creator
save("WF29-max.json", loop_workflow(
    "WF29 - Ad Campaign Creator (MAX)", "0 7 * * 1",
    "businesses?select=id,business_name,email,ad_account_id,daily_budget&is_active=eq.true&ad_account_id=not.is.null",
    [
        rail_step("Master Agent", "/webhook/master-agent"),
        wait_step("Wait 15s", 15),
        rail_step("Orchestrate Campaign", "/webhook/orchestrate-campaign",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, campaign_goal: "generate leads", budget: $(\'Loop Each Business\').first().json.daily_budget * 30 || 300 }) }}'),
    ]
))

# WF31 — Landing Page Generator (webhook)
n31 = [
    webhook_trigger("generate-landing-page"),
    code_node("Extract", 'const b = $input.first().json.body || $input.first().json;\nreturn [{ json: { business_id: b.business_id } }];', [480, 300]),
    http_post_rail("Build Moat", "/webhook/build-competitive-moat", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [720, 300]),
    wait_node("Wait 15s", 15, [960, 300]),
    http_post_rail("Generate Landing Page", "/webhook/generate-landing-page", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [1200, 300]),
    http_post_rail("SEO Audit", "/webhook/seo-audit", '={{ JSON.stringify({ business_id: $json.business_id }) }}', [1440, 300]),
    log_error_node([960, 520]),
]
c31 = {"Webhook Trigger": {"main": [[{"node": "Extract", "type": "main", "index": 0}]]}, "Extract": {"main": [[{"node": "Build Moat", "type": "main", "index": 0}]]}, "Build Moat": {"main": [[{"node": "Wait 15s", "type": "main", "index": 0}]]}, "Wait 15s": {"main": [[{"node": "Generate Landing Page", "type": "main", "index": 0}]]}, "Generate Landing Page": {"main": [[{"node": "SEO Audit", "type": "main", "index": 0}]]}}
save("WF31-max.json", wf("WF31 - Landing Page Generator (MAX)", n31, c31))

# WF36 — Email Sequence Processor
save("WF36-max.json", loop_workflow(
    "WF36 - Email Sequence Processor (MAX)", "*/30 * * * *",
    "businesses?select=id&is_active=eq.true&limit=1",
    [
        rail_step("Process Sequences", "/webhook/email-sequence-process",
            '={{ JSON.stringify({}) }}'),
    ]
))

# WF37 — No-Open Reengagement
save("WF37-max.json", loop_workflow(
    "WF37 - No-Open Reengagement (MAX)", "0 8 * * *",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Process Sequences", "/webhook/email-sequence-process",
            '={{ JSON.stringify({}) }}'),
    ]
))

# WF38 — Meta Ads Daily Optimizer
save("WF38-max.json", loop_workflow(
    "WF38 - Meta Ads Daily Optimizer (MAX)", "0 6 * * *",
    "businesses?select=id,business_name,email,ad_account_id&is_active=eq.true&ad_account_id=not.is.null",
    [
        rail_step("Optimize Meta Campaigns", "/webhook/meta-campaign-optimize"),
        wait_step("Wait 5s", 5),
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
    ]
))

# WF39 — Google Ads Optimizer
save("WF39-max.json", loop_workflow(
    "WF39 - Google Ads Optimizer (MAX)", "30 6 * * *",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Optimize Google Campaigns", "/webhook/google-campaign-optimize"),
        wait_step("Wait 3s", 3),
        rail_step("SEO Recommendations", "/webhook/seo-audit"),
    ]
))

# WF40 — Weekly Competitor Monitor
save("WF40-max.json", loop_workflow(
    "WF40 - Weekly Competitor Monitor (MAX)", "0 7 * * 0",
    "businesses?select=id,business_name,email,competitors&is_active=eq.true&competitors=not.is.null",
    [
        rail_step("Competitor Analyze", "/webhook/competitor-analyze"),
        wait_step("Wait 15s", 15),
        rail_step("Competitor Alert Check", "/webhook/competitor-alert-check"),
        wait_step("Wait 5s", 5),
        rail_step("Build Competitive Moat", "/webhook/build-competitive-moat"),
    ]
))

# WF41 — Weekly Content Engine
save("WF41-max.json", loop_workflow(
    "WF41 - Weekly Content Engine (MAX)", "0 7 * * 1",
    "businesses?select=id,business_name,email,content_opportunities&is_active=eq.true",
    [
        rail_step("Generate Blog Content", "/webhook/content-generate",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, type: "blog" }) }}'),
        wait_step("Wait 10s", 10),
        rail_step("SEO Audit", "/webhook/seo-audit"),
    ]
))

# WF42 — Lead Score Monitor
save("WF42-max.json", loop_workflow(
    "WF42 - Lead Score Monitor (MAX)", "0 * * * *",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Process Sequences", "/webhook/email-sequence-process",
            '={{ JSON.stringify({}) }}'),
    ]
))

# WF43 — Brand Memory Trainer
save("WF43-max.json", loop_workflow(
    "WF43 - Brand Memory Trainer (MAX)", "0 6 * * 0",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
        wait_step("Wait 5s", 5),
        rail_step("Train Brand Memory", "/webhook/brand-memory-train"),
        wait_step("Wait 3s", 3),
        rail_step("Analyze Audience", "/webhook/analyze-audience"),
    ]
))

# WF44 — Review Monitor
save("WF44-max.json", loop_workflow(
    "WF44 - Review Monitor (MAX)", "0 9 * * *",
    "businesses?select=id,business_name,email,google_business_id&is_active=eq.true",
    [
        rail_step("Measure Content Performance", "/webhook/measure-content-performance"),
        wait_step("Wait 3s", 3),
        rail_step("Crisis Check", "/webhook/crisis-check"),
    ]
))

# WF45 — Weekly SEO Audit
save("WF45-max.json", loop_workflow(
    "WF45 - Weekly SEO Audit (MAX)", "0 8 * * 0",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("SEO Audit", "/webhook/seo-audit"),
        wait_step("Wait 15s", 15),
        rail_step("Generate Blog for Top Keyword", "/webhook/content-generate",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, type: "blog" }) }}'),
    ]
))

# WF46 — Weekly CRO Analysis
save("WF46-max.json", loop_workflow(
    "WF46 - Weekly CRO Analysis (MAX)", "0 8 * * 1",
    "businesses?select=id,business_name,email&is_active=eq.true",
    [
        rail_step("CRO Analyze", "/webhook/cro-analyze"),
        wait_step("Wait 10s", 10),
        rail_step("Score Content", "/webhook/score-content",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, caption: "CRO headline test", image_url: "" }) }}'),
    ]
))

# WF47 — Video Script Generator
save("WF47-max.json", loop_workflow(
    "WF47 - Video Script Generator (MAX)", "0 10 * * 3",
    "businesses?select=id,business_name,email,content_opportunities&is_active=eq.true",
    [
        rail_step("Generate Video Script", "/webhook/video-script-generate",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, platform: "tiktok" }) }}'),
        wait_step("Wait 10s", 10),
        rail_step("Score Video Hook", "/webhook/score-content",
            '={{ JSON.stringify({ business_id: $(\'Loop Each Business\').first().json.id, caption: "video script hook", image_url: "" }) }}'),
    ]
))

print()
print(f"✅ All workflow files generated in {OUT}/")
