#!/usr/bin/env python3
"""
Agorium Bot — Posts debate content every 4 hours as one of 3 distinct personas.
Each run picks a random persona, then either argues in an existing debate (70%)
or creates a brand-new one (30%).
"""

import os
import random
import re
import sys
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

try:
    from supabase import create_client, Client
except ImportError:
    print("Run: pip install supabase openai")
    sys.exit(1)

try:
    from openai import OpenAI as OpenAIClient
except ImportError:
    print("Run: pip install supabase openai")
    sys.exit(1)


# ── Config ──────────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://auboquhnqswseneeosyj.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")   # service_role key
OPENAI_KEY   = os.environ.get("OPENAI_API_KEY", "")

MODEL = "gpt-5-mini-2025-08-07"

SIDES = ["for", "against"]


# ── Personas ─────────────────────────────────────────────────────────────────

PERSONAS = {
    "RighteousPaul": {
        "display_name": "RighteousPaul",
        "bio": "Christian conservative. Faith, family, and freedom.",
        "prompt_style": (
            "You are RighteousPaul — a devout Christian conservative and debate-forum regular. "
            "You argue from Scripture, natural law, and the wisdom of the Founding Fathers. "
            "You genuinely believe in faith and tradition as civilizational anchors. "
            "Be earnest, a little fired up, and human — not a caricature. "
            "Occasionally quote the Bible or appeal to 'what the Founders intended'. "
            "You're respectful but firm. No hedging. You mean it."
            "One paragraph (max 7 sentences, average 2-4) maximum for posts or debate 'background and stakes'."
        ),
    },
    "AtheaReason": {
        "display_name": "AtheaReason",
        "bio": "Secular humanist. Evidence over ideology.",
        "prompt_style": (
            "You are AtheaReason — a progressive secular humanist who lives for a good debate. "
            "You cite empirical studies, philosophers (Rawls, Mill, Singer, hooks), and social science. "
            "You find religious-based arguments frustrating and say so diplomatically. "
            "You're sharp, a little self-righteous, but you always bring receipts. "
            "Use phrases like 'the data actually shows', 'that's a category error', 'empirically speaking'. "
            "Push for systemic solutions. Call out logical fallacies by name."
            "One paragraph (max 7 sentences, average 2-4) maximum for posts or debate 'background and stakes'."
        ),
    },
    "VibezOfChaos": {
        "display_name": "VibezOfChaos",
        "bio": "Philosopher-gremlin. Questions everything including this bio.",
        "prompt_style": (
            "You are VibezOfChaos — an unclassifiable internet philosopher who refuses to be put in a box. "
            "You're equal parts Zizek, Baudrillard, and extremely online. "
            "You question the premise of every debate. You find the paradox. "
            "Your takes are chaotic but they land — there's always a real point buried in the chaos. "
            "Mix dense philosophical references with meme-aware language. "
            "Be genuinely surprising. The goal is to reframe the debate entirely, not just argue a side."
            "One paragraph (max 7 sentences, average 2-4) maximum for posts or debate 'background and stakes'."
        ),
    },
}


# ── Supabase helpers ─────────────────────────────────────────────────────────

def get_client() -> Client:
    if not SUPABASE_KEY:
        raise ValueError("SUPABASE_KEY is not set.")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def ensure_persona_user(sb: Client, persona: dict) -> None:
    """Create the persona's user row if it doesn't exist yet."""
    name    = persona["display_name"]
    name_lc = name.lower()
    try:
        res = sb.table("users").select("username_lc").eq("username_lc", name_lc).execute()
        if res.data:
            return  # already exists
        sb.table("users").insert({
            "username_lc": name_lc,
            "username":    name,
            "bio":         persona["bio"],
        }).execute()
        print(f"  Created user: {name}")
    except Exception as e:
        print(f"  Could not ensure user {name}: {e}")


def get_recent_posts(sb: Client, limit: int = 10) -> list[dict]:
    try:
        res = sb.table("posts").select("*").order("createdat", desc=True).limit(limit).execute()
        return res.data or []
    except Exception as e:
        print(f"  Could not fetch posts: {e}")
        return []


def get_recent_debates(sb: Client, limit: int = 50) -> list[dict]:
    try:
        res = (
            sb.table("posts")
            .select("*")
            .eq("type", "debate")
            .order("createdat", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []
    except Exception as e:
        print(f"  Could not fetch debates: {e}")
        return []


def get_post_by_id(sb: Client, post_id: str) -> Optional[dict]:
    try:
        res = sb.table("posts").select("*").eq("id", post_id).limit(1).execute()
        return (res.data or [None])[0]
    except Exception as e:
        print(f"  Could not fetch post {post_id}: {e}")
        return None


def get_debate_arguments(sb: Client, post_id: str) -> list[dict]:
    """Fetch all arguments in this debate in chronological order."""
    try:
        res = (
            sb.table("arguments")
            .select("*")
            .eq("postid", post_id)
            .order("createdat", desc=False)
            .execute()
        )
        return res.data or []
    except Exception as e:
        print(f"  Could not fetch arguments for post {post_id}: {e}")
        return []


def normalize_side(value) -> Optional[str]:
    side = str(value or "").strip().lower()
    if side in SIDES:
        return side
    return None


def opposite_side(side: str) -> str:
    return "against" if side == "for" else "for"


def parse_side_choice(text: str) -> Optional[str]:
    raw = str(text or "").strip().lower()
    if not raw:
        return None
    exact = re.match(r'^\s*["\']?(for|against)["\']?\s*[\.\!\,\;\:]?\s*$', raw)
    if exact:
        return exact.group(1)
    token = re.search(r"\b(for|against)\b", raw)
    if token:
        return token.group(1)
    return None


def parse_switch_choice(text: str) -> Optional[str]:
    raw = str(text or "").strip().lower()
    if not raw:
        return None
    exact = re.match(r'^\s*["\']?(switch|stay)["\']?\s*[\.\!\,\;\:]?\s*$', raw)
    if exact:
        return exact.group(1)
    token = re.search(r"\b(switch|stay)\b", raw)
    if token:
        return token.group(1)
    return None


def build_debate_context(persona: dict, debate_args: list[dict]) -> str:
    persona_lc = str(persona.get("display_name", "")).strip().lower()
    if not debate_args:
        return "No prior arguments exist in this debate yet."

    lines: list[str] = []
    for idx, arg in enumerate(debate_args, start=1):
        author = str(arg.get("author", "unknown")).strip() or "unknown"
        side = normalize_side(arg.get("side")) or "unknown"
        mine = "OWN" if author.lower() == persona_lc else "OTHER"
        body = str(arg.get("body", "")).strip()
        lines.append(f"[{idx}] {mine} | author={author} | side={side}\n{body}")
    return "\n\n".join(lines)


def choose_initial_side(persona: dict, post: dict, debate_args: list[dict]) -> str:
    client = OpenAIClient(api_key=OPENAI_KEY)
    title = post.get("title", "")
    body = post.get("body", "")
    context = build_debate_context(persona, debate_args)
    msg = client.chat.completions.create(
        model=MODEL,
        max_completion_tokens=40,
        messages=[
            {"role": "system", "content": persona["prompt_style"]},
            {
                "role": "user",
                "content": (
                    f"Debate title: {title}\n\nDebate body: {body}\n\n"
                    f"All arguments in debate:\n{context}\n\n"
                    f"Pick a side for {persona['display_name']}. "
                    "Return exactly one token: for or against."
                ),
            },
        ],
    )
    parsed = parse_side_choice(msg.choices[0].message.content or "")
    return parsed if parsed else "for"


def should_switch_side(persona: dict, post: dict, current_side: str, debate_args: list[dict]) -> bool:
    opposing = [a for a in debate_args if normalize_side(a.get("side")) == opposite_side(current_side)]
    if not opposing:
        return False

    client = OpenAIClient(api_key=OPENAI_KEY)
    title = post.get("title", "")
    body = post.get("body", "")
    context = build_debate_context(persona, debate_args)
    msg = client.chat.completions.create(
        model=MODEL,
        max_completion_tokens=40,
        messages=[
            {"role": "system", "content": persona["prompt_style"]},
            {
                "role": "user",
                "content": (
                    f"Debate title: {title}\n\nDebate body: {body}\n\n"
                    f"Current side: {current_side}\n\n"
                    f"All arguments in debate:\n{context}\n\n"
                    "Entries labeled OWN are your prior arguments. "
                    "Largely keep that view unless opposing arguments clearly changed your mind. "
                    "Return exactly one token: switch or stay."
                ),
            },
        ],
    )
    decision = parse_switch_choice(msg.choices[0].message.content or "")
    return decision == "switch"


def resolve_side(persona: dict, post: dict, debate_args: list[dict]) -> tuple[str, str]:
    persona_lc = str(persona.get("display_name", "")).strip().lower()
    own_args = [a for a in debate_args if str(a.get("author", "")).strip().lower() == persona_lc]

    latest_own_side = None
    for arg in reversed(own_args):
        parsed = normalize_side(arg.get("side"))
        if parsed:
            latest_own_side = parsed
            break

    if latest_own_side:
        if should_switch_side(persona, post, latest_own_side, debate_args):
            return opposite_side(latest_own_side), "mind-change-switch"
        return latest_own_side, "stick-with-own-history"

    return choose_initial_side(persona, post, debate_args), "initial-model"


# ── OpenAI content generation ─────────────────────────────────────────────────

def generate_argument(persona: dict, post: dict, side: str, debate_args: list[dict], side_source: str) -> str:
    """Generate an argument body to post in an existing debate."""
    client = OpenAIClient(api_key=OPENAI_KEY)
    title  = post.get("title", "")
    body   = post.get("body", "")
    context = build_debate_context(persona, debate_args)

    msg = client.chat.completions.create(
        model=MODEL,
        max_completion_tokens=5000,
        messages=[
            {"role": "system", "content": persona["prompt_style"]},
            {
                "role": "user",
                "content": (
                    f"You're arguing in this debate:\nTitle: {title}\n\n{body}\n\n"
                    f"Resolved side: {side.upper()} (source: {side_source}).\n\n"
                    "All arguments currently in this debate are below. "
                    "Entries marked OWN were written by you. "
                    "Largely keep your OWN view unless you are genuinely convinced to change.\n\n"
                    f"{context}\n\n"
                    "Direct clash requirements: target at least one OTHER argument by author and claim, "
                    "state exactly why it fails, and present a stronger counter-claim. "
                    "If there are multiple OTHER arguments, prioritize the strongest one and rebut it head-on. "
                    "No soft agreement language. "
                    "Include at least one sentence in this pattern: "
                    "\"<Author> said <claim>, but that's not right because <reason>.\"\n\n"
                    "Write your argument in exactly one paragraph (max 7 sentences, average 2-4). "
                    "No markdown. No headers. "
                    f"You must argue the {side.upper()} side."
                    "Argue hard. Make a real point. Be true to your character."
                ),
            },
        ],
    )
    return msg.choices[0].message.content.strip()


def generate_new_post(persona: dict) -> tuple[str, str]:
    """Generate a new debate post. Returns (title, body)."""
    client = OpenAIClient(api_key=OPENAI_KEY)

    msg = client.chat.completions.create(
        model=MODEL,
        max_completion_tokens=5000,
        messages=[
            {"role": "system", "content": persona["prompt_style"]},
            {
                "role": "user",
                "content": (
                    "Start a brand-new debate on a topic you genuinely care about. "
                    "Pick something political, ethical, or social — something real and contentious. "
                    "Format: first line is the TITLE only (no label), blank line, then exactly one paragraph "
                    "(max 7 sentences, average 2-4). "
                    "No markdown. Be opinionated. Don't be bland."
                ),
            },
        ],
    )
    raw   = msg.choices[0].message.content.strip()
    lines = raw.split("\n", 1)
    title = lines[0].strip()
    body  = lines[1].strip() if len(lines) > 1 else raw
    return title, body


# ── Posting logic ─────────────────────────────────────────────────────────────

def post_argument(sb: Client, persona: dict, post: dict, forced_side: Optional[str] = None) -> dict:
    debate_args = get_debate_arguments(sb, str(post.get("id", "")))
    manual_side = normalize_side(forced_side)
    if manual_side:
        side, side_source = manual_side, "manual-override"
    else:
        side, side_source = resolve_side(persona, post, debate_args)
    print(f"  [debug] side={side} source={side_source} args_in_context={len(debate_args)}")

    body = generate_argument(persona, post, side, debate_args, side_source)
    now  = datetime.now(timezone.utc).isoformat()
    arg_id = str(uuid4())
    try:
        sb.table("arguments").insert({
            "id":        arg_id,
            "postid":    post["id"],
            "side":      side,
            "body":      body,
            "author":    persona["display_name"],
            "createdat": now,
        }).execute()
        print(f"✅ {persona['display_name']} argued ({side}) on: \"{post.get('title', post['id'])}\"")
        return {
            "ok": True,
            "action": "argue",
            "persona": persona["display_name"],
            "post_id": str(post.get("id", "")),
            "post_title": str(post.get("title", "")),
            "side": side,
            "side_source": side_source,
            "argument_id": arg_id,
        }
    except Exception as e:
        print(f"❌ Failed to post argument: {e}")
        return {
            "ok": False,
            "action": "argue",
            "persona": persona["display_name"],
            "post_id": str(post.get("id", "")),
            "error": str(e),
        }


def post_new_debate(sb: Client, persona: dict) -> dict:
    title, body = generate_new_post(persona)
    now = datetime.now(timezone.utc).isoformat()
    post_id = str(uuid4())
    try:
        sb.table("posts").insert({
            "id":        post_id,
            "type":      "debate",
            "title":     title,
            "body":      body,
            "author":    persona["display_name"],
            "createdat": now,
            "tags":      [],
        }).execute()
        print(f"✅ {persona['display_name']} started new debate: \"{title}\"")
        return {
            "ok": True,
            "action": "new",
            "persona": persona["display_name"],
            "post_id": post_id,
            "post_title": title,
        }
    except Exception as e:
        print(f"❌ Failed to create debate: {e}")
        return {
            "ok": False,
            "action": "new",
            "persona": persona["display_name"],
            "error": str(e),
        }


def execute_action(
    persona_key: str,
    action: str,
    debate_id: Optional[str] = None,
    forced_side: Optional[str] = None,
) -> dict:
    if not OPENAI_KEY:
        return {"ok": False, "error": "OPENAI_API_KEY not set."}
    if persona_key not in PERSONAS:
        return {"ok": False, "error": f"Unknown persona: {persona_key}"}
    if action not in {"argue", "new"}:
        return {"ok": False, "error": f"Unknown action: {action}"}

    try:
        sb = get_client()
    except Exception as e:
        return {"ok": False, "error": str(e)}

    persona = PERSONAS[persona_key]
    ensure_persona_user(sb, persona)

    if action == "new":
        return post_new_debate(sb, persona)

    target = None
    if debate_id:
        target = get_post_by_id(sb, debate_id)
    if not target:
        debates = get_recent_debates(sb, limit=1)
        target = debates[0] if debates else None
    if not target:
        return {"ok": False, "error": "No debates available to argue on."}

    return post_argument(sb, persona, target, forced_side=forced_side)


# ── Main ─────────────────────────────────────────────────────────────────────

def run():
    print(f"\n🤖 Agorium Bot — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")

    if not OPENAI_KEY:
        print("❌ OPENAI_API_KEY not set.")
        sys.exit(1)

    sb = get_client()

    # Pick persona
    persona_key = random.choice(list(PERSONAS.keys()))
    persona     = PERSONAS[persona_key]
    print(f"\n🎭 Persona: {persona['display_name']}")

    # Ensure user exists
    ensure_persona_user(sb, persona)

    # 70% argue in existing debate, 30% start new one
    posts  = get_recent_posts(sb)
    action = "argue" if posts and random.random() < 0.7 else "new"

    if action == "argue":
        target = random.choice(posts[:5])
        print(f"   Action: argue on \"{target.get('title', target.get('id'))}\"")
        post_argument(sb, persona, target)
    else:
        print("   Action: create new debate")
        post_new_debate(sb, persona)

    print("\n✅ Done.\n")


if __name__ == "__main__":
    run()
