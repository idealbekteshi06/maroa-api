#!/usr/bin/env python3
"""Inject Fetch Business Context + system prompt into n8n workflows that call Anthropic."""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / "n8n-workflows"
FETCH_NAME = "Fetch Business Context"
URL_EXPR = (
    '={{ "https://maroa-api-production.up.railway.app/api/context/" + String('
    "$json.userId || $json.business_id || $json.user_id || $json.id || "
    "($json.biz && $json.biz.id) || "
    "$(\'Loop Each Business\').first().json.id || $(\'Loop Each Business\').first().json.user_id || "
    "$(\'Split In Batches\').first().json.id || $(\'Split In Batches\').first().json.user_id || "
    "$vars.userId || \"\") }}"
)


def has_claude_http(data: dict) -> bool:
    for n in data.get("nodes", []):
        url = str(n.get("parameters", {}).get("url", ""))
        if "api.anthropic.com" in url:
            return True
    return False


def has_fetch_node(data: dict) -> bool:
    return any(n.get("name") == FETCH_NAME for n in data.get("nodes", []))


def find_loop_name(data: dict) -> str | None:
    preferred = None
    fallback = None
    for n in data.get("nodes", []):
        if n.get("type") != "n8n-nodes-base.splitInBatches":
            continue
        name = n.get("name") or ""
        if name == "Loop Each Business":
            return name
        if preferred is None:
            preferred = name
        fallback = name
    return preferred or fallback


def anthropic_node_names(data: dict) -> list[str]:
    out = []
    for n in data.get("nodes", []):
        if "api.anthropic.com" in str(n.get("parameters", {}).get("url", "")):
            out.append(n["name"])
    return out


def predecessors_of(data: dict, target: str) -> list[str]:
    conns = data.get("connections", {})
    preds = []
    for src, c in conns.items():
        for branch in c.get("main", []):
            for edge in branch:
                if edge.get("node") == target:
                    preds.append(src)
    return preds


def insert_fetch_after_loop(data: dict, loop_name: str, fetch_id: str) -> None:
    conns = data.setdefault("connections", {})
    block = conns.get(loop_name)
    if not block or not block.get("main") or not block["main"][0]:
        return
    outs = block["main"][0]
    block["main"][0] = [{"node": FETCH_NAME, "type": "main", "index": 0}]
    existing = conns.get(FETCH_NAME, {"main": [[]]})
    if not existing.get("main"):
        existing["main"] = [[]]
    existing["main"][0] = outs
    conns[FETCH_NAME] = existing


def insert_fetch_before_node(data: dict, pred: str, target: str, fetch_id: str) -> None:
    conns = data.setdefault("connections", {})
    b = conns.get(pred)
    if not b or not b.get("main"):
        return
    replaced = False
    for branch in b["main"]:
        for edge in branch:
            if edge.get("node") == target:
                edge["node"] = FETCH_NAME
                replaced = True
    if not replaced:
        return
    conns[FETCH_NAME] = {"main": [[{"node": target, "type": "main", "index": 0}]]}


def add_fetch_node(data: dict, wf_slug: str) -> str:
    fetch_id = str(uuid.uuid4())
    pos = [-200, 300]
    for n in data.get("nodes", []):
        if n.get("type") == "n8n-nodes-base.splitInBatches":
            p = n.get("position")
            if isinstance(p, list) and len(p) >= 2:
                pos = [p[0] - 220, p[1]]
                break
    node = {
        "id": fetch_id,
        "name": FETCH_NAME,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": pos,
        "parameters": {
            "method": "GET",
            "url": URL_EXPR,
            "options": {"timeout": 30000},
        },
    }
    data.setdefault("nodes", []).append(node)
    return fetch_id


def patch_anthropic_parameters(params: dict) -> bool:
    url = str(params.get("url", ""))
    if "api.anthropic.com" not in url:
        return False
    sys_mark = "Fetch Business Context"
    # bodyParameters (LinkedIn / Twitter / TikTok style)
    bp = params.get("bodyParameters")
    if bp and isinstance(bp.get("parameters"), list):
        plist = bp["parameters"]
        if any(p.get("name") == "system" for p in plist):
            return False
        new_pl = []
        inserted = False
        for p in plist:
            new_pl.append(p)
            if p.get("name") == "max_tokens" and not inserted:
                new_pl.append(
                    {
                        "name": "system",
                        "value": "={{ $('Fetch Business Context').first().json.full_master_prompt }}",
                    }
                )
                inserted = True
        if inserted:
            bp["parameters"] = new_pl
            return True
    jb = params.get("jsonBody")
    if isinstance(jb, str) and jb.strip().startswith("=") and '"messages"' in jb:
        if sys_mark in jb and "full_master_prompt" in jb:
            return False
        # Spaced JSON style: ={"model": "claude-...", "max_tokens": 2000, "messages": [
        jb2 = re.sub(
            r'"max_tokens":\s*(\d+),\s*"messages"',
            r'"max_tokens": \1, "system": $(\'Fetch Business Context\').first().json.full_master_prompt, "messages"',
            jb,
            count=1,
        )
        if jb2 == jb:
            jb2 = re.sub(
                r'(,"max_tokens":\d+)(,"messages")',
                r"\1,system:$('Fetch Business Context').first().json.full_master_prompt\2",
                jb,
                count=1,
            )
        if jb2 == jb:
            jb2 = re.sub(
                r'(,"max_tokens":\s*\d+)(,"messages")',
                r"\1,system:$('Fetch Business Context').first().json.full_master_prompt\2",
                jb,
                count=1,
            )
        if jb2 != jb:
            params["jsonBody"] = jb2
            return True
    body = params.get("body")
    if isinstance(body, str) and body.strip().startswith("=") and '"messages"' in body:
        if sys_mark in body and "full_master_prompt" in body:
            return False
        body2 = re.sub(
            r'(\n\s*"max_tokens":\s*\d+,)\s*(\n\s*"messages")',
            r"\1\n  system: $('Fetch Business Context').first().json.full_master_prompt,\2",
            body,
            count=1,
        )
        if body2 == body:
            body2 = re.sub(
                r'(\n\s*"max_tokens":\s*\d+,)(\s*\n\s*"messages")',
                r"\1\n  system: $('Fetch Business Context').first().json.full_master_prompt,\2",
                body,
                count=1,
            )
        if body2 != body:
            params["body"] = body2
            return True
    return False


def process_file(path: Path) -> tuple[bool, str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not has_claude_http(data):
        return False, "no anthropic http"
    if has_fetch_node(data):
        return False, "already has fetch"
    loop = find_loop_name(data)
    ants = anthropic_node_names(data)
    if not ants:
        return False, "no anthropic nodes"
    fetch_id = add_fetch_node(data, path.stem)
    if loop:
        insert_fetch_after_loop(data, loop, fetch_id)
    else:
        first = ants[0]
        preds = predecessors_of(data, first)
        if len(preds) != 1:
            return False, f"need single predecessor for {first}, got {preds}"
        insert_fetch_before_node(data, preds[0], first, fetch_id)
    patched = 0
    for n in data.get("nodes", []):
        if "api.anthropic.com" not in str(n.get("parameters", {}).get("url", "")):
            continue
        if patch_anthropic_parameters(n.get("parameters", {})):
            patched += 1
    if patched == 0:
        return False, "failed to patch anthropic body"
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return True, f"ok, patched {patched} claude nodes"


def main() -> None:
    updated = []
    skipped = []
    for path in sorted(WORKFLOWS_DIR.glob("*.json")):
        ok, msg = process_file(path)
        if ok:
            updated.append((path.name, msg))
        else:
            if "no anthropic" in msg or "already has" in msg:
                continue
            skipped.append((path.name, msg))
    print("UPDATED", len(updated))
    for name, msg in updated:
        print(f"  {name}: {msg}")
    if skipped:
        print("SKIPPED/ERR")
        for name, msg in skipped:
            print(f"  {name}: {msg}")


if __name__ == "__main__":
    main()
