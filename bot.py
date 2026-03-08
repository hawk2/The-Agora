#!/usr/bin/env python3
"""
Agorium Bot — Posts debate content every 4 hours as alternating personas.
Always argues on the most recent debate post.
"""

import os
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
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
OPENAI_KEY   = os.environ.get("OPENAI_API_KEY", "")

MODEL = "gpt-5-mini-2025-08-07"
PAUL_NAME = "RighteousPaul"
VALID_SIDES = {"for", "against"}
ATHENA_MAX_STYLE_RETRIES = 3
PREDICT_SIDE_MAX_ATTEMPTS = 3
SIDE_CLASSIFY_MAX_ATTEMPTS = 3
SWITCH_DECISION_MAX_ATTEMPTS = 3
PAUL_STYLE_PATTERNS = [
    r"\bscripture\b",
    r"\bbible\b",
    r"\bgod\b",
    r"\bjesus\b",
    r"\bchristian\b",
    r"\bfaith\b",
    r"\bfounding fathers\b",
    r"\bfounders\b",
    r"\bnatural law\b",
    r"\bacts\s+\d+:\d+\b",
    r"\bproverbs\s+\d+:\d+\b",
]

PERSONAS = [
    {
        "display_name": "Athena",
        "bio": "Stoic strategist. Logic-first, sharp, and precise.",
        "prompt_style": (
            "You are Athena — a disciplined, high-IQ debate tactician. "
            "You argue from logic, evidence, and clear causal reasoning. "
            "You stay composed, incisive, and direct. "
            "No fluff, no vague claims, no hedging. "
            "Be respectful but decisive. You mean every point."
        ),
    },
    {
        "display_name": "RighteousPaul",
        "bio": "Christian conservative. Faith, family, and freedom.",
        "prompt_style": (
            "You are RighteousPaul — a devout Christian conservative and debate-forum regular. "
            "You argue from Scripture, natural law, and the wisdom of the Founding Fathers. "
            "You genuinely believe in faith and tradition as civilizational anchors. "
            "Be earnest, a little fired up, and human — not a caricature. "
            "Occasionally quote the Bible or appeal to 'what the Founders intended'. "
            "You're respectful but firm. No hedging. You mean it."
        ),
    },
    {
        "display_name": "ProgressiveMaya",
        "bio": "Progressive policy wonk. Climate, equity, and public investment.",
        "prompt_style": (
            "You are ProgressiveMaya — a sharp progressive debater focused on data and policy outcomes. "
            "You argue for strong social programs, climate action, labor protections, and civil rights. "
            "You cite evidence, historical context, and practical policy tradeoffs. "
            "Be confident, clear, and persuasive without sounding robotic. "
            "You're respectful but direct. No hedging. You mean it."
        ),
    },
    {
        "display_name": "LibertyJake",
        "bio": "Civil libertarian. Skeptical of state power and censorship.",
        "prompt_style": (
            "You are LibertyJake — a civil libertarian and constitutional stickler. "
            "You prioritize free speech, due process, privacy rights, and limits on government power. "
            "You challenge paternalism and mission creep in institutions. "
            "Use plain language and principled reasoning. "
            "Be respectful but unflinching. No hedging. You mean it."
        ),
    },
    {
        "display_name": "PragmaticNora",
        "bio": "Centrist pragmatist. Outcomes over ideology.",
        "prompt_style": (
            "You are PragmaticNora — a practical centrist who values what actually works. "
            "You weigh costs, implementation details, and second-order effects. "
            "You dislike purity tests and ideological slogans. "
            "Argue with clarity, concrete examples, and policy realism. "
            "Be civil, firm, and candid. No hedging. You mean it."
        ),
    },
]

PERSONA_ORDER = [p["display_name"] for p in PERSONAS]
PERSONA_BY_NAME = {p["display_name"]: p for p in PERSONAS}
PERSONA = PERSONAS[0]
PAUL_PERSONA = PERSONA_BY_NAME.get(PAUL_NAME, PERSONAS[0])


# ── Supabase helpers ──────────────────────────────────────────────────────────

def get_client() -> Client:
    if not SUPABASE_KEY:
        raise ValueError("SUPABASE_KEY is not set.")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def ensure_persona_user(sb: Client) -> None:
    name    = PERSONA["display_name"]
    name_lc = name.lower()
    try:
        res = sb.table("users").select("username_lc").eq("username_lc", name_lc).execute()
        if res.data:
            return
        sb.table("users").insert({
            "username_lc": name_lc,
            "username":    name,
            "bio":         PERSONA["bio"],
        }).execute()
        print(f"  Created user: {name}")
    except Exception as e:
        print(f"  Could not ensure user {name}: {e}")


def get_last_bot_persona(sb: Client) -> Optional[str]:
    try:
        res = (
            sb.table("arguments")
            .select("author")
            .in_("author", PERSONA_ORDER)
            .order("createdat", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            return str(res.data[0].get("author", "")).strip() or None
    except Exception as e:
        print(f"  Could not fetch last bot argument author: {e}")

    try:
        res = (
            sb.table("posts")
            .select("author")
            .in_("author", PERSONA_ORDER)
            .order("createdat", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            return str(res.data[0].get("author", "")).strip() or None
    except Exception as e:
        print(f"  Could not fetch last bot post author: {e}")

    return None


def choose_alternating_persona(sb: Client) -> dict:
    last_persona = get_last_bot_persona(sb)
    if not last_persona or last_persona not in PERSONA_BY_NAME:
        return PERSONAS[0]
    idx = PERSONA_ORDER.index(last_persona)
    next_idx = (idx + 1) % len(PERSONAS)
    return PERSONAS[next_idx]


def get_recent_posts(sb: Client, limit: int = 10) -> list[dict]:
    try:
        res = sb.table("posts").select("*").order("createdat", desc=True).limit(limit).execute()
        return res.data or []
    except Exception as e:
        print(f"  Could not fetch posts: {e}")
        return []


def get_most_recent_debate(sb: Client) -> Optional[dict]:
    try:
        res = (
            sb.table("posts")
            .select("*")
            .eq("type", "debate")
            .order("createdat", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]
        # Fallback for datasets that may not have a "type" field on older rows.
        fallback = sb.table("posts").select("*").order("createdat", desc=True).limit(1).execute()
        return (fallback.data or [None])[0]
    except Exception as e:
        print(f"  Could not fetch most recent debate: {e}")
        return None


# ── Side resolution helpers ───────────────────────────────────────────────────

def normalize_side(value) -> Optional[str]:
    side = str(value or "").strip().lower()
    if side in VALID_SIDES:
        return side
    return None


def opposite_side(side: str) -> str:
    return "against" if side == "for" else "for"


def is_paul_author(value) -> bool:
    return str(value or "").strip().lower() == PAUL_NAME.lower()


def get_latest_paul_argument(sb: Client, post_id: str) -> Optional[dict]:
    try:
        res = (
            sb.table("arguments")
            .select("*")
            .eq("postid", post_id)
            .eq("author", PAUL_NAME)
            .order("createdat", desc=True)
            .limit(1)
            .execute()
        )
        return (res.data or [None])[0]
    except Exception as e:
        print(f"  Could not fetch latest {PAUL_NAME} argument: {e}")
        return None


def parse_side_choice(text: str) -> Optional[str]:
    raw = str(text or "").strip().lower()
    if not raw:
        return None

    exact = re.match(r'^\s*["\']?(for|against)["\']?\s*[\.\!\,\;\:]?\s*$', raw)
    if exact:
        return exact.group(1)

    json_like = re.search(r'"side"\s*:\s*"(for|against)"', raw)
    if json_like:
        return json_like.group(1)

    first_token = re.search(r"\b(for|against)\b", raw)
    if first_token:
        return first_token.group(1)
    return None


def deterministic_side_from_key(key: str) -> str:
    checksum = sum(ord(ch) for ch in str(key))
    return "for" if checksum % 2 == 0 else "against"


def predict_paul_side(post: dict) -> tuple[str, str]:
    client = OpenAIClient(api_key=OPENAI_KEY)
    post_id = str(post.get("id", "")).strip()
    title = post.get("title", "")
    body = post.get("body", "")
    fallback_key = f"{PAUL_NAME}|{post_id or title}"

    prompt_variants = [
        {
            "role": "system",
            "content": PAUL_PERSONA["prompt_style"],
        },
        {
            "role": "system",
            "content": (
                "You are classifying likely stance for RighteousPaul. "
                "Respond with one token only: for or against."
            ),
        },
    ]

    votes: list[str] = []
    for system_prompt in prompt_variants:
        for _ in range(PREDICT_SIDE_MAX_ATTEMPTS):
            msg = client.chat.completions.create(
                model=MODEL,
                max_completion_tokens=32,
                messages=[
                    system_prompt,
                    {
                        "role": "user",
                        "content": (
                            f"Debate title: {title}\n\nDebate body: {body}\n\n"
                            "Which side would RighteousPaul most likely take? "
                            "Return exactly one token: for or against."
                        ),
                    },
                ],
            )
            raw = extract_text(msg)
            parsed = parse_side_choice(raw)
            if parsed:
                votes.append(parsed)
                continue
            print(f"  [debug] Could not parse predicted Paul side from: {raw!r}")

    if votes and all(vote == votes[0] for vote in votes):
        return votes[0], "anti-paul-predicted"

    fallback_side = deterministic_side_from_key(fallback_key)
    print(f"  [debug] Using hash fallback for predicted Paul side: {fallback_side} (votes={votes})")
    return fallback_side, "anti-paul-predicted-hash"


def resolve_athena_initial_side(sb: Client, post: dict) -> tuple[Optional[str], Optional[str], bool, str]:
    post_id = str(post.get("id", ""))
    if not post_id:
        return None, None, False, "missing-post-id"

    paul_arg = get_latest_paul_argument(sb, post_id)
    if paul_arg:
        paul_side = normalize_side(paul_arg.get("side"))
        if paul_side:
            paul_body = str(paul_arg.get("body", "")).strip()
            return opposite_side(paul_side), paul_body, True, "anti-paul-latest-argument"
        print(f"  [debug] {PAUL_NAME} has an argument with invalid side; falling back to prediction.")

    if is_paul_author(post.get("author")):
        return "against", None, False, "anti-paul-authored-debate"

    predicted_side, predicted_source = predict_paul_side(post)
    return opposite_side(predicted_side), None, False, predicted_source


def get_last_persona_argument(sb: Client, post_id: str) -> Optional[dict]:
    try:
        res = (
            sb.table("arguments")
            .select("*")
            .eq("postid", post_id)
            .eq("author", PERSONA["display_name"])
            .order("createdat", desc=True)
            .limit(1)
            .execute()
        )
        return (res.data or [None])[0]
    except Exception as e:
        print(f"  Could not fetch last argument for {PERSONA['display_name']}: {e}")
        return None


def get_recent_opposing_arguments(
    sb: Client,
    post_id: str,
    current_side: str,
    created_after: Optional[str],
    limit: int = 3,
) -> list[dict]:
    try:
        query = (
            sb.table("arguments")
            .select("*")
            .eq("postid", post_id)
            .eq("side", opposite_side(current_side))
            .neq("author", PERSONA["display_name"])
        )
        if created_after:
            query = query.gt("createdat", created_after)
        res = query.order("createdat", desc=True).limit(limit).execute()
        return res.data or []
    except Exception as e:
        print(f"  Could not fetch opposing arguments: {e}")
        return []


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


def classify_initial_side(post: dict) -> tuple[str, str]:
    client = OpenAIClient(api_key=OPENAI_KEY)
    post_id = str(post.get("id", "")).strip()
    title = post.get("title", "")
    body = post.get("body", "")
    fallback_key = f"{PERSONA['display_name']}|{post_id or title}"
    prompt_variants = [
        {
            "role": "system",
            "content": PERSONA["prompt_style"],
        },
        {
            "role": "system",
            "content": (
                f"You are selecting the stance for persona {PERSONA['display_name']}. "
                "Return one token only: for or against."
            ),
        },
    ]

    votes: list[str] = []
    for system_prompt in prompt_variants:
        for _ in range(SIDE_CLASSIFY_MAX_ATTEMPTS):
            msg = client.chat.completions.create(
                model=MODEL,
                max_completion_tokens=32,
                messages=[
                    system_prompt,
                    {
                        "role": "user",
                        "content": (
                            f"Debate title: {title}\n\nDebate body: {body}\n\n"
                            f"Which side should {PERSONA['display_name']} take in character? "
                            "Return exactly one token: for or against."
                        ),
                    },
                ],
            )
            parsed = parse_side_choice(extract_text(msg))
            if parsed:
                votes.append(parsed)

    if votes and all(vote == votes[0] for vote in votes):
        return votes[0], "initial-model"

    fallback_side = deterministic_side_from_key(fallback_key)
    print(f"  [debug] Using hash fallback for initial side: {fallback_side} (votes={votes})")
    return fallback_side, "initial-model-hash-fallback"


def should_switch_side(
    post: dict,
    current_side: str,
    own_last_arg: dict,
    opposing_args: list[dict],
) -> bool:
    if not opposing_args:
        return False

    client = OpenAIClient(api_key=OPENAI_KEY)
    title = post.get("title", "")
    body = post.get("body", "")
    own_body = to_one_paragraph(str(own_last_arg.get("body", "")))[:1200]
    opposing_blob = "\n\n".join(
        f"Opposing argument {idx + 1} by {arg.get('author', 'unknown')}: "
        f"{to_one_paragraph(str(arg.get('body', '')))[:800]}"
        for idx, arg in enumerate(opposing_args[:3])
    )

    decisions: list[str] = []
    for _ in range(SWITCH_DECISION_MAX_ATTEMPTS):
        msg = client.chat.completions.create(
            model=MODEL,
            max_completion_tokens=32,
            messages=[
                {
                    "role": "system",
                    "content": (
                        PERSONA["prompt_style"] + "\n\n"
                        "Decide if you should switch sides based on argument strength only. "
                        "Return one token only: switch or stay."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Debate title: {title}\n\nDebate body: {body}\n\n"
                        f"Current side: {current_side}\n\n"
                        f"Your last argument:\n{own_body}\n\n"
                        f"New opposing arguments:\n{opposing_blob}\n\n"
                        "If the opposing case is genuinely stronger and you are convinced, return switch. "
                        "Otherwise return stay. Return exactly one token: switch or stay."
                    ),
                },
            ],
        )
        decision = parse_switch_choice(extract_text(msg))
        if decision:
            decisions.append(decision)

    if decisions and all(decision == "switch" for decision in decisions):
        return True
    if decisions:
        print(f"  [debug] staying on current side (switch votes={decisions})")
    else:
        print("  [debug] staying on current side (no parseable switch/stay votes)")
    return False


def resolve_persona_side(sb: Client, post: dict) -> tuple[Optional[str], Optional[str], bool, str]:
    post_id = str(post.get("id", ""))
    if not post_id:
        return None, None, False, "missing-post-id"

    if PERSONA["display_name"] == PAUL_NAME and is_paul_author(post.get("author")):
        return "for", None, False, "paul-authored-debate"

    own_last_arg = get_last_persona_argument(sb, post_id)
    if own_last_arg:
        current_side = normalize_side(own_last_arg.get("side"))
        if current_side:
            opposing_args = get_recent_opposing_arguments(
                sb,
                post_id,
                current_side,
                own_last_arg.get("createdat"),
            )
            if opposing_args and should_switch_side(post, current_side, own_last_arg, opposing_args):
                return opposite_side(current_side), None, False, "mind-change-switch"
            return current_side, None, False, "stick-with-prior"

    if PERSONA["display_name"] == "Athena":
        side, paul_context, mention_paul, source = resolve_athena_initial_side(sb, post)
        if side:
            return side, paul_context, mention_paul, source

    initial_side, source = classify_initial_side(post)
    return initial_side, None, False, source


# ── OpenAI helpers ────────────────────────────────────────────────────────────

def extract_text(msg) -> str:
    """Robustly extract text from an OpenAI response regardless of SDK version."""
    choice = msg.choices[0]
    content = choice.message.content

    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                parts.append(block.get("text", ""))
            elif hasattr(block, "text"):
                parts.append(block.text or "")
            else:
                parts.append(str(block))
        return " ".join(p for p in parts if p).strip()

    # Fallback: try output_text (some SDK versions)
    if hasattr(choice.message, "output_text"):
        return (choice.message.output_text or "").strip()

    return ""


def looks_like_paul_style(text: str) -> bool:
    lower = (text or "").lower()
    return any(re.search(pattern, lower) for pattern in PAUL_STYLE_PATTERNS)


def to_one_paragraph(text: str) -> str:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    return " ".join(lines).strip()


# ── Content generation ────────────────────────────────────────────────────────

def generate_argument(post: dict, side: str, paul_context: Optional[str], mention_paul: bool) -> str:
    client = OpenAIClient(api_key=OPENAI_KEY)
    title  = post.get("title", "")
    body   = post.get("body", "")
    result = ""
    is_athena = PERSONA["display_name"] == "Athena"
    rebuttal_context = ""
    if paul_context:
        clipped = paul_context[:600]
        if mention_paul:
            rebuttal_context = (
                f"\n\n{PAUL_NAME}'s latest argument to rebut:\n"
                f"{clipped}\n"
                "Address this directly and explain why it is wrong."
            )

    for attempt in range(1, ATHENA_MAX_STYLE_RETRIES + 1):
        system_prompt = PERSONA["prompt_style"]
        if is_athena:
            system_prompt += (
                "\n\nHard constraints:\n"
                "- Never cite or reference Scripture, Bible verses, God, Jesus, church, or Christian doctrine.\n"
                "- Never invoke the Founders, natural law, or religious/traditional authority.\n"
                "- Use analytical reasoning: incentives, tradeoffs, institutional design, and real-world outcomes.\n"
                "- Keep Athena's tone: precise, cool-headed, and strategic."
            )

        msg = client.chat.completions.create(
            model=MODEL,
            max_completion_tokens=5000,
            messages=[
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {
                    "role": "user",
                    "content": (
                        f"You're arguing in this debate:\nTitle: {title}\n\n{body}\n\n"
                        f"You must argue the {side.upper()} side. Do not switch sides."
                        f"{rebuttal_context}\n\n"
                        "Write your argument in exactly one paragraph. Plain text only, no markdown, no headers. "
                        "Argue hard. Make a real point. Be true to your character."
                    ),
                },
            ],
        )
        print(f"  [debug] finish_reason: {msg.choices[0].finish_reason}")
        print(f"  [debug] message type: {type(msg.choices[0].message.content)}")
        print(f"  [debug] message raw: {repr(msg.choices[0].message)}")
        result = to_one_paragraph(extract_text(msg))
        print(f"  [debug] extracted length: {len(result)} chars")
        if not result:
            continue
        if is_athena and looks_like_paul_style(result):
            if attempt < ATHENA_MAX_STYLE_RETRIES:
                print("  [debug] Athena style drift detected; retrying generation...")
            continue
        return result

    return result


def generate_new_post() -> tuple[str, str]:
    client = OpenAIClient(api_key=OPENAI_KEY)

    msg = client.chat.completions.create(
        model=MODEL,
        max_completion_tokens=5000,
        messages=[
            {"role": "system", "content": PERSONA["prompt_style"]},
            {
                "role": "user",
                "content": (
                    "Start a brand-new debate on a topic you genuinely care about. "
                    "Pick something political, ethical, or social — something real and contentious. "
                    "Output format: first line is the TITLE only (no label, no colon), "
                    "then a blank line, then exactly one paragraph of your argument. "
                    "Plain text only, no markdown, no bullet points. Be opinionated."
                ),
            },
        ],
    )
    raw = extract_text(msg)
    print(f"  [debug] new post length: {len(raw)} chars")
    print(f"  [debug] raw preview: {raw[:120]!r}")

    all_lines = raw.split("\n")
    title = ""
    body_lines = []
    title_found = False
    for line in all_lines:
        if not title_found:
            if line.strip():
                title = line.strip()
                title_found = True
        else:
            body_lines.append(line)
    body = to_one_paragraph("\n".join(body_lines).strip() or raw)
    title = title or "A Debate Worth Having"
    return title, body


# ── Posting logic ─────────────────────────────────────────────────────────────

def increment_post_argument_counters(sb: Client, post_id: str, side: str) -> None:
    try:
        res = (
            sb.table("posts")
            .select("argcount, forcount, againstcount")
            .eq("id", post_id)
            .limit(1)
            .execute()
        )
        post_row = (res.data or [None])[0]
        if not post_row:
            return

        updates = {
            "argcount": int(post_row.get("argcount") or 0) + 1,
        }
        if side == "for":
            updates["forcount"] = int(post_row.get("forcount") or 0) + 1
        elif side == "against":
            updates["againstcount"] = int(post_row.get("againstcount") or 0) + 1

        sb.table("posts").update(updates).eq("id", post_id).execute()
    except Exception as e:
        print(f"  [warn] Could not update post counters for {post_id}: {e}")


def post_argument(sb: Client, post: dict):
    side, paul_context, mention_paul, side_source = resolve_persona_side(sb, post)
    if not side:
        print(f"❌ Could not resolve side ({side_source}) — skipping insert")
        return

    print(f"  [debug] {PERSONA['display_name']} side: {side} (source: {side_source})")
    body = generate_argument(post, side, paul_context, mention_paul)
    if not body:
        print("❌ Empty argument body — skipping insert")
        return
    now  = datetime.now(timezone.utc).isoformat()
    try:
        sb.table("arguments").insert({
            "id":        str(uuid4()),
            "postid":    post["id"],
            "side":      side,
            "body":      body,
            "author":    PERSONA["display_name"],
            "createdat": now,
        }).execute()
        increment_post_argument_counters(sb, str(post["id"]), side)
        print(f"✅ {PERSONA['display_name']} argued ({side}) on: \"{post.get('title', post['id'])}\"")
    except Exception as e:
        print(f"❌ Failed to post argument: {e}")


def post_new_debate(sb: Client):
    title, body = generate_new_post()
    if not body:
        print("❌ Empty post body — skipping insert")
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        sb.table("posts").insert({
            "id":        str(uuid4()),
            "type":      "debate",
            "title":     title,
            "body":      body,
            "author":    PERSONA["display_name"],
            "createdat": now,
            "tags":      [],
        }).execute()
        print(f"✅ {PERSONA['display_name']} started new debate: \"{title}\"")
    except Exception as e:
        print(f"❌ Failed to create debate: {e}")


# ── Main ──────────────────────────────────────────────────────────────────────

def run():
    global PERSONA
    print(f"\n🤖 Agorium Bot — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")

    if not OPENAI_KEY:
        print("❌ OPENAI_API_KEY not set.")
        sys.exit(1)

    sb = get_client()
    PERSONA = choose_alternating_persona(sb)

    print(f"\n🎭 Persona: {PERSONA['display_name']}")
    ensure_persona_user(sb)

    target = get_most_recent_debate(sb)
    if not target:
        print("❌ No debates found to argue.")
        return

    print(f"   Action: argue on latest debate \"{target.get('title', target.get('id'))}\"")
    post_argument(sb, target)

    print("\n✅ Done.\n")


if __name__ == "__main__":
    run()
