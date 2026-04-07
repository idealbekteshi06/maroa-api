#!/usr/bin/env python3
"""
Apply targeted improvements to 14 n8n workflow JSON files.
Improvements:
  1 - Smarter Claude prompts (prepend business context)
  2 - Error recovery (wrap Code nodes in try/catch if not already)
  5 - Personalized email footer (append CTA block to Gmail nodes)
  8 - Seasonal intelligence for WF15 only
"""

import json
import os
import re
import copy

WORKFLOWS_DIR = "/Users/bekteshi/Desktop/Maroa.ai/n8n-workflows"

TARGET_FILES = [
    "15_instant_content_on_signup.json",
    "16_ai_inbox_manager.json",
    "17_monthly_report_email.json",
    "18_reactivation_campaign.json",
    "19_upsell_automation.json",
    "20_testimonial_collector.json",
    "21_seasonal_campaign_creator.json",
    "22_viral_content_detector.json",
    "23_video_script_generator.json",
    "24_smart_budget_optimizer.json",
    "25_customer_journey_emails.json",
    "26_ad_creative_refresh.json",
    "27_weekly_wins_social_post.json",
    "28_google_my_business_poster.json",
]

EMAIL_CTA_BLOCK = """<div style="background:#f0f4ff;padding:15px;border-radius:8px;margin:20px 0;border-left:4px solid #4F46E5;"><p style="margin:0;color:#4F46E5;font-weight:bold;">Your Maroa.ai AI is working 24/7 for your business.</p><p style="margin:8px 0 0;color:#374151;">Log in anytime to see your results and approve new content.</p></div><p style="text-align:center;"><a href="https://maroa-ai-marketing-automator.lovable.app" style="background:#4F46E5;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Open Your Dashboard &rarr;</a></p>"""

GMAIL_CREDENTIAL = {"gmailOAuth2": {"id": "BajY2aODIl8cGn0X", "name": "Gmail account"}}

SEASONAL_HOLIDAY_CODE = """
// Seasonal intelligence
const now = new Date();
const month = now.getMonth() + 1;
const day = now.getDate();
const holidays = [
  { month: 1, day: 1, name: 'New Year' }, { month: 2, day: 14, name: "Valentine's Day" },
  { month: 3, day: 17, name: "St Patrick's Day" }, { month: 4, day: 20, name: 'Easter' },
  { month: 5, day: 12, name: "Mother's Day" }, { month: 6, day: 16, name: "Father's Day" },
  { month: 7, day: 4, name: 'Independence Day' }, { month: 10, day: 31, name: 'Halloween' },
  { month: 11, day: 28, name: 'Thanksgiving' }, { month: 12, day: 25, name: 'Christmas' }
];
let upcomingHoliday = null;
for (const h of holidays) {
  const hDate = new Date(now.getFullYear(), h.month - 1, h.day);
  const diff = Math.ceil((hDate - now) / (1000*60*60*24));
  if (diff >= 0 && diff <= 14) { upcomingHoliday = { ...h, daysAway: diff }; break; }
}
// Add to the output json
json.upcoming_holiday = upcomingHoliday ? upcomingHoliday.name + ' in ' + upcomingHoliday.daysAway + ' days' : null;"""


def get_business_context_prefix(existing_prompt: str, filename: str) -> str:
    """
    Determine the right variable pattern from the existing prompt and return the context prefix.
    """
    # Detect which variable pattern is used for business_name in the existing prompt
    # Patterns seen: $('Extract Body').first().json.X, $node['Split In Batches'].json['X'], $json.X
    if "Extract Body" in existing_prompt:
        var = lambda f: f"$('Extract Body').first().json.{f}"
    elif "Split In Batches'].json" in existing_prompt:
        var = lambda f: f"$node['Split In Batches'].json['{f}']"
    elif "$json." in existing_prompt:
        var = lambda f: f"$json.{f}"
    else:
        var = lambda f: f"$json.{f}"

    prefix = (
        f"Business context: {{{{{var('business_name')}}}}} in {{{{{var('industry')}}}}} industry, "
        f"located in {{{{{var('location')}}}}}. "
        f"Target audience: {{{{{var('target_audience')}}}}}. "
        f"Brand tone: {{{{{var('brand_tone')}}}}}. "
        f"Marketing goal: {{{{{var('marketing_goal')}}}}}. "
        f"Marketing strategy: {{{{{var('marketing_strategy')}}}}}. "
        "Current month context: use the current month and season to make content timely. "
        "Make all output feel like it was written by someone who knows this business personally. "
        "Match the brand tone exactly. "
    )
    return prefix


def improvement_1_smarter_prompts(node: dict, filename: str, changes: list) -> bool:
    """Prepend business context to Claude API calls."""
    params = node.get("parameters", {})
    json_body = params.get("jsonBody", "")
    if not json_body:
        return False

    # Check it's a Claude call
    url = params.get("url", "")
    if "api.anthropic.com/v1/messages" not in url:
        return False

    # Parse the jsonBody - it may be a string starting with '='
    raw = json_body
    is_expression = raw.startswith("=")
    body_str = raw[1:] if is_expression else raw

    # Find the content field in messages array - it could be embedded in JS expression
    # We need to find the user content string and prepend to it
    # The content is after "content": " and before the closing "
    # Since these are n8n expression strings with + concatenation or literal strings,
    # we handle both cases

    # Try to find the literal content string in jsonBody
    # Pattern: "content": "..." (static) or "content\": \"..." in JS-concat expressions
    # We'll look for the content field value in the JSON body string

    # For WF15, WF17-like patterns where jsonBody is a JSON string:
    # {"model":..., "messages":[{"role":"user","content":"..."}]}
    # For WF16,21-28 where jsonBody is an expression with + concatenation:
    # ={..., "content": "text" + var + "more text"}

    changed = False

    # Attempt 1: Pure JSON body (not expression concat) - parse and modify
    if not ('+' in body_str and '$node' in body_str or '+' in body_str and '$json' in body_str):
        try:
            parsed = json.loads(body_str)
            messages = parsed.get("messages", [])
            for msg in messages:
                if msg.get("role") == "user" and "content" in msg:
                    existing_content = msg["content"]
                    if "Business context:" not in existing_content:
                        prefix = get_business_context_prefix(existing_content, filename)
                        msg["content"] = prefix + existing_content
                        changed = True
            if changed:
                new_body_str = json.dumps(parsed)
                params["jsonBody"] = ("=" + new_body_str) if is_expression else new_body_str
                changes.append(f"  [IMP1] {node['name']}: prepended business context to Claude prompt")
        except (json.JSONDecodeError, KeyError):
            pass

    # Attempt 2: Expression with string concatenation (the content is after \"content\": \")
    if not changed and ('+' in body_str or '$node' in body_str):
        # Find the content value in the expression - it follows "content\":
        # Pattern like: \"content\":\"...actual prompt text...\"
        # or: \"content\": \"...\" + var + \"...\"
        # We prepend before the first content string

        # Find the start of the content value
        content_start_pattern = r'(\\\"content\\\":\s*\\\")'
        m = re.search(content_start_pattern, body_str)
        if m:
            # Get what's after the opening quote to understand variables used
            after_quote = body_str[m.end():]
            existing_prompt_fragment = after_quote[:200]
            if "Business context:" not in body_str:
                prefix = get_business_context_prefix(existing_prompt_fragment, filename)
                # Escape for JSON-in-string context
                escaped_prefix = prefix.replace('"', '\\"')
                new_body_str = body_str[:m.end()] + escaped_prefix + after_quote
                params["jsonBody"] = ("=" + new_body_str) if is_expression else new_body_str
                changed = True
                changes.append(f"  [IMP1] {node['name']}: prepended business context (expr mode) to Claude prompt")

    return changed


def improvement_2_error_recovery(node: dict, changes: list) -> bool:
    """Wrap Code node jsCode in try/catch if not already wrapped."""
    params = node.get("parameters", {})
    js_code = params.get("jsCode", "")
    if not js_code:
        return False

    stripped = js_code.strip()
    if stripped.startswith("try {") or stripped.startswith("try{"):
        return False  # Already has try/catch

    # Wrap in try/catch
    wrapped = (
        "try {\n"
        + js_code
        + "\n} catch(e) {\n"
        "  console.error('Workflow error:', e.message);\n"
        "  return [{ json: { error: e.message, skipped: true, business_id: '' } }];\n"
        "}"
    )
    params["jsCode"] = wrapped
    changes.append(f"  [IMP2] {node['name']}: wrapped jsCode in try/catch error recovery")
    return True


def improvement_5_personalized_emails(node: dict, changes: list) -> bool:
    """Append CTA block to Gmail node messages and fix credentials."""
    params = node.get("parameters", {})
    message = params.get("message", "")
    if not message:
        return False

    # Check if already has the CTA block
    if "maroa-ai-marketing-automator.lovable.app" in message and "Open Your Dashboard" in message:
        # Fix credentials if needed
        creds = node.get("credentials", {})
        if creds.get("gmailOAuth2", {}).get("id") != "BajY2aODIl8cGn0X":
            node["credentials"] = GMAIL_CREDENTIAL
        return False

    # Append CTA block before </body> or at end
    cta = EMAIL_CTA_BLOCK

    if "</body>" in message:
        new_message = message.replace("</body>", cta + "</body>", 1)
    elif "</html>" in message:
        new_message = message.replace("</html>", cta + "</html>", 1)
    else:
        new_message = message + cta

    params["message"] = new_message

    # Also fix credentials
    node["credentials"] = GMAIL_CREDENTIAL

    changes.append(f"  [IMP5] {node['name']}: appended personalized CTA block + fixed credentials")
    return True


def improvement_8_seasonal_intelligence_wf15(wf: dict, changes: list) -> bool:
    """WF15 only: add holiday detection to Extract Body code node + update Claude prompt."""
    changed = False

    # Find the Extract Body code node
    extract_node = None
    claude_node = None
    for node in wf.get("nodes", []):
        if node.get("type") == "n8n-nodes-base.code" and node.get("name") in ("Extract Body", "Extract Request Data"):
            extract_node = node
        if node.get("type") == "n8n-nodes-base.httpRequest" and "api.anthropic.com" in node.get("parameters", {}).get("url", ""):
            claude_node = node

    if extract_node:
        params = extract_node.get("parameters", {})
        js_code = params.get("jsCode", "")

        if "upcoming_holiday" not in js_code:
            # The existing code ends with: return [{ json: { ... }}];
            # We need to inject the holiday logic after extracting the data,
            # right before the final return, and add the field to the json object.

            # Find the last return statement and inject before it
            # Strategy: find "return [{" pattern and insert holiday code before it,
            # then update the json object to include upcoming_holiday

            # Step 1: add holiday detection before the return
            # Step 2: insert upcoming_holiday into the returned json object

            # Find where the return statement begins
            ret_match = re.search(r'(return\s*\[\s*\{\s*json\s*:\s*\{)', js_code)
            if ret_match:
                # Insert holiday detection before the return
                insert_pos = ret_match.start()
                # Build new code: existing code up to return + holiday detection + return with new field

                code_before_return = js_code[:insert_pos]
                return_and_after = js_code[insert_pos:]

                # Add json.upcoming_holiday injection
                holiday_injection = SEASONAL_HOLIDAY_CODE + "\n"

                # Now add upcoming_holiday to the json object inside the return
                # Find the closing }} of the json object in the return
                # Insert after the last field in the json object
                # We'll look for the pattern before the closing }}: and add the field

                # Find a good insertion point in return_and_after - before the closing `}}]`
                closing_match = re.search(r'\}\s*\}\s*\]', return_and_after)
                if closing_match:
                    # Extract the content before the closing
                    before_closing = return_and_after[:closing_match.start()]
                    closing_part = return_and_after[closing_match.start():]

                    # Add upcoming_holiday field
                    new_return = before_closing + ",\n  upcoming_holiday: json.upcoming_holiday" + "\n" + closing_part
                else:
                    new_return = return_and_after

                new_js = code_before_return + holiday_injection + new_return

                # Wrap the new code block - but we need to be careful since this code node
                # might already have a try/catch (improvement 2 runs after).
                # For now just use the new_js as-is; improvement 2 will wrap it.
                params["jsCode"] = new_js
                changes.append(f"  [IMP8] Extract Body: added seasonal holiday detection")
                changed = True

    # Update Claude call node to include holiday context in prompt
    if claude_node and changed:
        params = claude_node.get("parameters", {})
        json_body = params.get("jsonBody", "")
        if "upcoming_holiday" not in json_body and json_body:
            holiday_prompt_addition = (
                " If upcoming_holiday is set, add: "
                "IMPORTANT: {{ $('Extract Body').first().json.upcoming_holiday }} "
                "— naturally weave this into the content for a {{ $('Extract Body').first().json.industry }} business."
            )

            # Find the end of the content string just before the closing quote of the content field
            # The content ends before '.\"}' or similar
            # Insert before the final period or before the closing quote

            # For WF15, jsonBody is a JSON string. Find the content value.
            raw = json_body
            is_expr = raw.startswith("=")
            body_str = raw[1:] if is_expr else raw

            try:
                parsed = json.loads(body_str)
                messages = parsed.get("messages", [])
                for msg in messages:
                    if msg.get("role") == "user" and "content" in msg:
                        msg["content"] = msg["content"] + holiday_prompt_addition
                new_body = json.dumps(parsed)
                params["jsonBody"] = ("=" + new_body) if is_expr else new_body
                changes.append(f"  [IMP8] {claude_node['name']}: added holiday context injection to Claude prompt")
            except (json.JSONDecodeError, KeyError):
                pass

    return changed


def process_file(filename: str) -> dict:
    """Process a single workflow file applying all improvements."""
    filepath = os.path.join(WORKFLOWS_DIR, filename)
    changes = []

    with open(filepath, "r", encoding="utf-8") as f:
        wf = json.load(f)

    is_wf15 = filename.startswith("15_")

    nodes = wf.get("nodes", [])

    # For WF15, apply seasonal intelligence first (before error recovery wraps the code)
    if is_wf15:
        improvement_8_seasonal_intelligence_wf15(wf, changes)

    # Apply per-node improvements
    for node in nodes:
        node_type = node.get("type", "")

        # Improvement 1: Smarter Claude prompts
        if node_type == "n8n-nodes-base.httpRequest":
            url = node.get("parameters", {}).get("url", "")
            if "api.anthropic.com/v1/messages" in url:
                improvement_1_smarter_prompts(node, filename, changes)

        # Improvement 2: Error recovery for Code nodes
        if node_type == "n8n-nodes-base.code":
            improvement_2_error_recovery(node, changes)

        # Improvement 5: Personalized emails for Gmail nodes
        if node_type == "n8n-nodes-base.gmail":
            improvement_5_personalized_emails(node, changes)

    # Validate JSON is still parseable
    try:
        json_str = json.dumps(wf, indent=2, ensure_ascii=False)
        json.loads(json_str)  # Validate
    except Exception as e:
        return {"file": filename, "status": "ERROR", "error": str(e), "changes": changes}

    # Write back
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(json_str)
        f.write("\n")

    return {
        "file": filename,
        "status": "OK",
        "changes_count": len(changes),
        "changes": changes,
    }


def main():
    print("=" * 70)
    print("Maroa.ai n8n Workflow Improvement Script")
    print("=" * 70)
    print()

    results = []
    for filename in TARGET_FILES:
        filepath = os.path.join(WORKFLOWS_DIR, filename)
        if not os.path.exists(filepath):
            results.append({"file": filename, "status": "NOT FOUND", "changes": []})
            continue

        result = process_file(filename)
        results.append(result)

    # Print summary
    success_count = 0
    error_count = 0
    for r in results:
        status = r["status"]
        fname = r["file"]
        if status == "OK":
            success_count += 1
            count = r.get("changes_count", 0)
            print(f"[OK] {fname} — {count} change(s)")
            for c in r.get("changes", []):
                print(c)
        elif status == "NOT FOUND":
            error_count += 1
            print(f"[MISS] {fname} — file not found")
        else:
            error_count += 1
            print(f"[ERR] {fname} — {r.get('error', 'unknown error')}")
            for c in r.get("changes", []):
                print(c)
        print()

    print("=" * 70)
    print(f"Summary: {success_count} files updated successfully, {error_count} errors")
    print("=" * 70)


if __name__ == "__main__":
    main()
