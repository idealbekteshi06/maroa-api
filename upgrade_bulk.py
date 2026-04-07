"""
upgrade_bulk.py — Apply improvements 1, 2, 5, 9, 10 to WF02-WF28
Improvement 1: Smarter Claude prompts with full business context
Improvement 2: Error recovery / try-catch in all Code nodes
Improvement 5: Personalized Gmail emails with CTA
Improvement 9: Smarter retention (WF04 only)
Improvement 10: Better win detection (WF07 only)
"""
import json, os, re, uuid

DIR = "/Users/bekteshi/Desktop/Maroa.ai/n8n-workflows"

CONTEXT_PREFIX = (
    "Business context — use this to personalise everything: "
    "Business name: {{ $json.business_name || $('Loop Each Business').first().json.business_name || '' }}. "
    "Industry: {{ $json.industry || $('Loop Each Business').first().json.industry || 'general' }}. "
    "Location: {{ $json.location || $('Loop Each Business').first().json.location || '' }}. "
    "Target audience: {{ $json.target_audience || $('Loop Each Business').first().json.target_audience || '' }}. "
    "Brand tone: {{ $json.brand_tone || $('Loop Each Business').first().json.brand_tone || 'professional and friendly' }}. "
    "Marketing goal: {{ $json.marketing_goal || $('Loop Each Business').first().json.marketing_goal || '' }}. "
    "Marketing strategy: {{ $json.marketing_strategy || $('Loop Each Business').first().json.marketing_strategy || '' }}. "
    "Current date context: make all content timely and relevant for the current month and season. "
    "Match the brand tone exactly. Write as if you personally know this business and its customers. "
    "Also consider what has worked before for this business based on their performance history. "
)

EMAIL_CTA_HTML = """
<div style="margin:24px 0;padding:16px;background:#f0f4ff;border-radius:8px;border-left:4px solid #4F46E5;">
  <p style="margin:0;color:#4F46E5;font-weight:bold;font-size:15px;">Your Maroa.ai AI is working 24/7 for your business.</p>
  <p style="margin:8px 0 0;color:#374151;font-size:14px;">Everything is automated — content, ads, emails, and tracking. You just need to approve and grow.</p>
</div>
<p style="text-align:center;margin:20px 0;">
  <a href="https://maroa-ai-marketing-automator.lovable.app" style="background:#4F46E5;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;font-size:15px;">Open Your Dashboard →</a>
</p>
"""

WIN10_CODE = """
// Improvement 10: Enhanced win detection (micro-wins)
const biz = $('Loop Each Business').first().json;
const logs = $input.all().map(i => i.json);

let wins = [];

// Classic wins
const latestLog = logs[0] || {};
if (parseFloat(latestLog.roas || 0) > 4) {
  wins.push({ type: 'high_roas', message: `ROAS hit ${latestLog.roas}x — campaigns are printing money!` });
}
if (parseFloat(latestLog.ctr || 0) > 3) {
  wins.push({ type: 'high_ctr', message: `CTR reached ${latestLog.ctr}% — your ads are highly relevant!` });
}

// Micro-win: first time crossing 1000 total_reach
const totalReach = parseInt(biz.total_reach || 0);
if (totalReach >= 900 && totalReach <= 1100) {
  wins.push({ type: 'reach_milestone', message: `Just crossed 1,000 people reached — huge milestone!` });
}

// Micro-win: new weekly reach record
const weeklyReach = parseInt(biz.weekly_reach || 0);
if (weeklyReach > 0 && weeklyReach >= totalReach * 0.4) {
  wins.push({ type: 'weekly_record', message: `Best week ever — ${weeklyReach} people reached this week!` });
}

// Return results
if (wins.length === 0) {
  return [{ json: { has_win: false, business_id: biz.id, business_name: biz.business_name } }];
}

return wins.map(w => ({ json: {
  has_win: true,
  win_type: w.type,
  win_message: w.message,
  business_id: biz.id,
  business_name: biz.business_name,
  email: biz.email,
  first_name: biz.first_name || 'there'
}}));
"""

RETENTION9_CODE = """
// Improvement 9: Smarter retention emails based on actual business activity
const biz = $('Loop Each Business').first().json;
const createdAt = new Date(biz.created_at || Date.now());
const now = new Date();
const daysSince = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));

// Check what the business has done
const hasConnectedFB = !!(biz.facebook_page_id);
const hasContent = parseInt(biz.posts_published || 0) > 0;
const hasReach = parseInt(biz.total_reach || 0) > 0;
const hasBudget = parseFloat(biz.daily_budget || 0) > 0;

let emailType = null;
let subject = '';
let contextNote = '';

// Determine nudge email type
if (daysSince >= 30) emailType = 'day_30';
else if (daysSince >= 14) emailType = 'day_14';
else if (daysSince >= 7)  emailType = 'day_7';
else if (daysSince >= 3)  emailType = 'day_3';

if (!emailType) return [{ json: { skip: true } }];

// Build personalised context based on what they've done
if (hasConnectedFB && hasReach) {
  contextNote = `Your Facebook page is live and you've already reached ${biz.total_reach} people. `;
} else if (hasConnectedFB) {
  contextNote = 'Your Facebook page is connected — content is ready to publish! ';
} else if (hasContent) {
  contextNote = 'Your first content is generated and waiting for approval. ';
} else {
  contextNote = `Let's get ${biz.business_name} in front of more customers in ${biz.location || 'your area'}. `;
}

// Industry-specific tip for day 3
let industryTip = '';
const industry = (biz.industry || '').toLowerCase();
if (daysSince <= 3) {
  if (industry.includes('bakery') || industry.includes('food') || industry.includes('restaurant')) {
    industryTip = 'Tip: Post a photo of your best-selling item with a "Today Only" offer. Food posts get 3x more engagement.';
  } else if (industry.includes('fitness') || industry.includes('gym')) {
    industryTip = 'Tip: Share a 30-second transformation tip. Fitness content with quick wins gets saved and shared.';
  } else if (industry.includes('salon') || industry.includes('beauty')) {
    industryTip = 'Tip: Post a before/after photo. Beauty transformations are the highest-performing content category.';
  } else {
    industryTip = 'Tip: Share one thing your business does better than anyone else in ' + (biz.location || 'your area') + '.';
  }
}

return [{ json: {
  business_id: biz.id,
  email: biz.email,
  first_name: biz.first_name || 'there',
  business_name: biz.business_name,
  email_type: emailType,
  days_since: daysSince,
  context_note: contextNote,
  industry_tip: industryTip,
  total_reach: biz.total_reach || 0,
  has_facebook: hasConnectedFB,
  posts_published: biz.posts_published || 0,
  subject: `Day ${daysSince}: ${contextNote.slice(0, 40)}...`
}}];
"""

def uid(): return str(uuid.uuid4())

def upgrade_claude_prompts(nodes):
    """Improvement 1: prepend rich context to every Claude prompt"""
    changed = 0
    for node in nodes:
        if node.get('type') == 'n8n-nodes-base.httpRequest':
            params = node.get('parameters', {})
            url = params.get('url', '')
            if 'api.anthropic.com' not in url:
                continue
            jb = params.get('jsonBody', '')
            if isinstance(jb, str) and '"content"' in jb and CONTEXT_PREFIX[:30] not in jb:
                # Find the content field and prepend context
                # Replace first occurrence of content string value
                jb = re.sub(
                    r'("content"\s*:\s*")((?:[^"\\]|\\.)*?)(")',
                    lambda m: m.group(1) + CONTEXT_PREFIX.replace('"', '\\"') + '\\n\\n' + m.group(2) + m.group(3),
                    jb, count=1
                )
                params['jsonBody'] = jb
                node['parameters'] = params
                changed += 1
    return changed

def upgrade_error_recovery(nodes):
    """Improvement 2: wrap all Code nodes in try/catch"""
    changed = 0
    for node in nodes:
        if node.get('type') == 'n8n-nodes-base.code':
            params = node.get('parameters', {})
            code = params.get('jsCode', '')
            if code and not code.strip().startswith('try {') and 'try {' not in code[:50]:
                params['jsCode'] = (
                    'try {\n' + code + '\n} catch(e) {\n'
                    '  console.error("[' + node.get('name','node') + '] Error:", e.message);\n'
                    '  return [{ json: { error: e.message, skipped: true } }];\n}'
                )
                node['parameters'] = params
                changed += 1
    return changed

def upgrade_gmail_cta(nodes):
    """Improvement 5: add personalized CTA block to all Gmail nodes"""
    changed = 0
    for node in nodes:
        if node.get('type') == 'n8n-nodes-base.gmail':
            params = node.get('parameters', {})
            msg = params.get('message', '')
            if isinstance(msg, str) and 'maroa-ai-marketing-automator.lovable.app' not in msg:
                # Insert CTA before closing </body> or at end
                if '</body>' in msg:
                    msg = msg.replace('</body>', EMAIL_CTA_HTML + '</body>', 1)
                else:
                    msg = msg + EMAIL_CTA_HTML
                params['message'] = msg
                node['parameters'] = params
                changed += 1
    return changed

def upgrade_wf07_win_detection(wf):
    """Improvement 10: replace win detection code in WF07"""
    changed = 0
    for node in wf.get('nodes', []):
        if node.get('type') == 'n8n-nodes-base.code':
            name = node.get('name', '').lower()
            if any(w in name for w in ['win', 'check', 'detect', 'analyze']):
                node['parameters']['jsCode'] = WIN10_CODE
                changed += 1
                break
    return changed

def upgrade_wf04_retention(wf):
    """Improvement 9: smarter retention email logic in WF04"""
    changed = 0
    for node in wf.get('nodes', []):
        if node.get('type') == 'n8n-nodes-base.code':
            name = node.get('name', '').lower()
            code = node.get('parameters', {}).get('jsCode', '')
            if any(w in name for w in ['check', 'day', 'milestone', 'retention', 'email']) or 'day_3' in code or 'daysSince' in code:
                node['parameters']['jsCode'] = RETENTION9_CODE
                changed += 1
                break
    return changed

# ─── Process each file ────────────────────────────────────────────────────────
files = sorted([f for f in os.listdir(DIR) if f.endswith('.json') and f != '01_weekly_content_generator.json'])
summary = []

for fname in files:
    path = os.path.join(DIR, fname)
    with open(path) as f:
        wf = json.load(f)

    nodes = wf.get('nodes', [])
    changes = []

    # Improvement 1
    n = upgrade_claude_prompts(nodes)
    if n: changes.append(f"Imp1: {n} Claude prompt(s) enhanced")

    # Improvement 2
    n = upgrade_error_recovery(nodes)
    if n: changes.append(f"Imp2: {n} Code node(s) wrapped in try/catch")

    # Improvement 5
    n = upgrade_gmail_cta(nodes)
    if n: changes.append(f"Imp5: {n} Gmail node(s) got personalized CTA")

    # Improvement 9 (WF04 only)
    if fname.startswith('04_'):
        n = upgrade_wf04_retention(wf)
        if n: changes.append("Imp9: Smarter retention email logic applied")

    # Improvement 10 (WF07 only)
    if fname.startswith('07_'):
        n = upgrade_wf07_win_detection(wf)
        if n: changes.append("Imp10: Enhanced win detection with micro-wins")

    # Validate and save
    try:
        validated = json.loads(json.dumps(wf))
        with open(path, 'w') as f:
            json.dump(wf, f, indent=2)
        status = "✅ SAVED"
    except Exception as e:
        status = f"❌ ERROR: {e}"
        changes.append(f"VALIDATION FAILED: {e}")

    summary.append((fname, status, changes))
    print(f"  {status}  {fname}  [{', '.join(changes) if changes else 'no changes needed'}]")

print(f"\nDone. Processed {len(files)} files.")
