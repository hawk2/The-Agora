import OpenAI from "npm:openai";
import { createClient } from "npm:@supabase/supabase-js";

const MODEL = "gpt-5-mini-2025-08-07";
const SIDES = ["for", "against"] as const;
const PAUL_NAME = "RighteousPaul";
type Side = (typeof SIDES)[number];
type BotAction = "argue" | "new";
const BOT_UI_ACTION_MAX_CLAIM_ATTEMPTS = 5;
const PREDICT_SIDE_MAX_ATTEMPTS = 3;
const SIDE_CLASSIFY_MAX_ATTEMPTS = 3;
const SWITCH_DECISION_MAX_ATTEMPTS = 3;
const DECISION_MAX_COMPLETION_TOKENS = 256;
const ARGUMENT_MAX_COMPLETION_TOKENS = 1200;
const NEW_POST_MAX_COMPLETION_TOKENS = 900;
const MODEL_EMPTY_RETRY_ATTEMPTS = 3;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ── Personas ─────────────────────────────────────────────────────────────────

const PERSONAS = {
  RighteousPaul: {
    display_name: "RighteousPaul",
    bio: "Christian conservative. Faith, family, and freedom.",
    prompt_style:
      "You are RighteousPaul — a devout Christian conservative and debate-forum regular. " +
      "You argue from Scripture, natural law, and the wisdom of the Founding Fathers. " +
      "You genuinely believe in faith and tradition as civilizational anchors. " +
      "Be earnest, a little fired up, and human — not a caricature. " +
      "Occasionally quote the Bible or appeal to 'what the Founders intended'. " +
      "You're respectful but firm. No hedging. You mean it.",
  },
  AtheaReason: {
    display_name: "AtheaReason",
    bio: "Secular humanist. Evidence over ideology.",
    prompt_style:
      "You are AtheaReason — a progressive secular humanist who lives for a good debate. " +
      "You cite empirical studies, philosophers (Rawls, Mill, Singer, hooks), and social science. " +
      "You find religious-based arguments frustrating and say so diplomatically. " +
      "You're sharp, a little self-righteous, but you always bring receipts. " +
      "Use phrases like 'the data actually shows', 'that's a category error', 'empirically speaking'. " +
      "Push for systemic solutions. Call out logical fallacies by name.",
  },
  VibezOfChaos: {
    display_name: "VibezOfChaos",
    bio: "Philosopher-gremlin. Questions everything including this bio.",
    prompt_style:
      "You are VibezOfChaos — an unclassifiable internet philosopher who refuses to be put in a box. " +
      "You're equal parts Zizek, Baudrillard, and extremely online. " +
      "You question the premise of every debate. You find the paradox. " +
      "Your takes are chaotic but they land — there's always a real point buried in the chaos. " +
      "Mix dense philosophical references with meme-aware language. " +
      "Be genuinely surprising. The goal is to reframe the debate entirely, not just argue a side.",
  },
} as const;

type PersonaKey = keyof typeof PERSONAS;
type Persona = (typeof PERSONAS)[PersonaKey];

function isAthenaEquivalent(persona: Persona): boolean {
  const name = String(persona.display_name).toLowerCase();
  return name === "athena" || name === "atheareason";
}

// ── User helper ───────────────────────────────────────────────────────────────

async function ensurePersonaUser(
  sb: any,
  persona: Persona,
): Promise<void> {
  const nameLc = persona.display_name.toLowerCase();
  const { data } = await sb.from("users").select("username_lc").eq("username_lc", nameLc).maybeSingle();
  if (data) return;
  const { error } = await sb.from("users").insert({
    username_lc: nameLc,
    username: persona.display_name,
    bio: persona.bio,
  });
  if (error) console.warn(`  Could not create user ${persona.display_name}: ${error.message}`);
  else console.log(`  Created user: ${persona.display_name}`);
}

function normalizeSide(raw: unknown): Side | null {
  const side = String(raw ?? "").trim().toLowerCase();
  return side === "for" || side === "against" ? side : null;
}

function oppositeSide(side: Side): Side {
  return side === "for" ? "against" : "for";
}

function isPaulAuthor(raw: unknown): boolean {
  return String(raw ?? "").trim().toLowerCase() === PAUL_NAME.toLowerCase();
}

async function getLatestPaulArgument(
  sb: any,
  postId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await sb
    .from("arguments")
    .select("*")
    .eq("postid", postId)
    .eq("author", PAUL_NAME)
    .order("createdat", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`  Could not fetch latest ${PAUL_NAME} argument: ${error.message}`);
    return null;
  }
  return (data as Record<string, unknown> | null) ?? null;
}

function parseSideChoice(raw: unknown): Side | null {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;
  const exact = text.match(/^\s*["']?(for|against)["']?\s*[\.\!\,\;\:]?\s*$/);
  if (exact?.[1] === "for" || exact?.[1] === "against") return exact[1];
  const jsonLike = text.match(/"side"\s*:\s*"(for|against)"/);
  if (jsonLike?.[1] === "for" || jsonLike?.[1] === "against") return jsonLike[1];
  const token = text.match(/\b(for|against)\b/);
  if (token?.[1] === "for" || token?.[1] === "against") return token[1];
  return null;
}

function parseSwitchDecision(raw: unknown): "switch" | "stay" | null {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;
  const exact = text.match(/^\s*["']?(switch|stay)["']?\s*[\.\!\,\;\:]?\s*$/);
  if (exact?.[1] === "switch" || exact?.[1] === "stay") return exact[1];
  const token = text.match(/\b(switch|stay)\b/);
  if (token?.[1] === "switch" || token?.[1] === "stay") return token[1];
  return null;
}

function deterministicSideFromKey(key: string): Side {
  let checksum = 0;
  for (const ch of String(key)) checksum += ch.charCodeAt(0);
  return checksum % 2 === 0 ? "for" : "against";
}

function extractChatMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as Record<string, unknown>;
  const content = msg.content;

  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        if (part.trim()) parts.push(part);
        continue;
      }
      if (!part || typeof part !== "object") continue;
      const item = part as Record<string, unknown>;
      const text =
        typeof item.text === "string" ? item.text
          : typeof item.content === "string" ? item.content
            : typeof item.value === "string" ? item.value
              : "";
      if (text.trim()) parts.push(text);
    }
    if (parts.length) return parts.join("\n");
  }

  const refusal = msg.refusal;
  if (typeof refusal === "string") return refusal;
  return "";
}

async function predictPaulSide(
  ai: OpenAI,
  post: Record<string, unknown>,
): Promise<{ side: Side; source: string }> {
  const postId = String(post.id ?? "").trim();
  const title = post.title ?? "";
  const body = post.body ?? "";
  const fallbackKey = `${PAUL_NAME}|${postId || String(title)}`;

  const promptVariants = [
    { role: "system" as const, content: PERSONAS.RighteousPaul.prompt_style },
    {
      role: "system" as const,
      content: "You are classifying likely stance for RighteousPaul. Respond with one token only: for or against.",
    },
  ];

  const votes: Side[] = [];
  for (const systemPrompt of promptVariants) {
    for (let i = 0; i < PREDICT_SIDE_MAX_ATTEMPTS; i++) {
      const msg = await ai.chat.completions.create({
        model: MODEL,
        max_completion_tokens: DECISION_MAX_COMPLETION_TOKENS,
        messages: [
          systemPrompt,
          {
            role: "user",
            content:
              `Debate title: ${title}\n\nDebate body: ${body}\n\n` +
              `Which side would RighteousPaul most likely take? Return exactly one token: for or against.`,
          },
        ],
      });
      const parsed = parseSideChoice(extractChatMessageText(msg.choices[0].message));
      if (parsed) votes.push(parsed);
    }
  }
  if (votes.length && votes.every((v) => v === votes[0])) {
    return { side: votes[0], source: "anti-paul-predicted" };
  }
  const fallbackSide = deterministicSideFromKey(fallbackKey);
  console.warn(`  [debug] Using hash fallback for predicted Paul side: ${fallbackSide} (votes=${JSON.stringify(votes)})`);
  return { side: fallbackSide, source: "anti-paul-predicted-hash" };
}

async function resolveAthenaInitialSide(
  ai: OpenAI,
  sb: any,
  post: Record<string, unknown>,
): Promise<{ side: Side; source: string; paulContext: string | null; mentionPaul: boolean }> {
  const postId = String(post.id ?? "");
  if (!postId) return { side: "for", source: "initial-model", paulContext: null, mentionPaul: false };

  const latestPaul = await getLatestPaulArgument(sb, postId);
  if (latestPaul) {
    const paulSide = normalizeSide(latestPaul.side);
    if (paulSide) {
      return {
        side: oppositeSide(paulSide),
        source: "anti-paul-latest-argument",
        paulContext: String(latestPaul.body ?? "").slice(0, 600),
        mentionPaul: true,
      };
    }
  }

  if (isPaulAuthor(post.author)) {
    return {
      side: "against",
      source: "anti-paul-authored-debate",
      paulContext: null,
      mentionPaul: false,
    };
  }

  const predictedPaul = await predictPaulSide(ai, post);
  return {
    side: oppositeSide(predictedPaul.side),
    source: predictedPaul.source,
    paulContext: null,
    mentionPaul: false,
  };
}

async function getLastPersonaArgument(
  sb: any,
  postId: string,
  personaName: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await sb
    .from("arguments")
    .select("*")
    .eq("postid", postId)
    .eq("author", personaName)
    .order("createdat", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`  Could not fetch last argument for ${personaName}: ${error.message}`);
    return null;
  }
  return (data as Record<string, unknown> | null) ?? null;
}

async function getRecentOpposingArguments(
  sb: any,
  postId: string,
  currentSide: Side,
  personaName: string,
  createdAfter: unknown,
  limit = 3,
): Promise<Record<string, unknown>[]> {
  let query = sb
    .from("arguments")
    .select("*")
    .eq("postid", postId)
    .eq("side", oppositeSide(currentSide))
    .neq("author", personaName);
  if (createdAfter) {
    query = query.gt("createdat", String(createdAfter));
  }
  const { data, error } = await query.order("createdat", { ascending: false }).limit(limit);
  if (error) {
    console.warn(`  Could not fetch opposing arguments: ${error.message}`);
    return [];
  }
  return (data as Record<string, unknown>[] | null) ?? [];
}

async function classifyInitialSide(
  ai: OpenAI,
  persona: Persona,
  post: Record<string, unknown>,
): Promise<{ side: Side; source: string }> {
  const postId = String(post.id ?? "").trim();
  const title = post.title ?? "";
  const body = post.body ?? "";
  const fallbackKey = `${persona.display_name}|${postId || String(title)}`;
  const promptVariants = [
    { role: "system" as const, content: persona.prompt_style },
    {
      role: "system" as const,
      content:
        `You are selecting stance for ${persona.display_name}. ` +
        `Return one token only: for or against.`,
    },
  ];

  const votes: Side[] = [];
  for (const systemPrompt of promptVariants) {
    for (let i = 0; i < SIDE_CLASSIFY_MAX_ATTEMPTS; i++) {
      const msg = await ai.chat.completions.create({
        model: MODEL,
        max_completion_tokens: DECISION_MAX_COMPLETION_TOKENS,
        messages: [
          systemPrompt,
          {
            role: "user",
            content:
              `Debate title: ${title}\n\nDebate body: ${body}\n\n` +
              `Which side should ${persona.display_name} take in character? ` +
              `Return exactly one token: for or against.`,
          },
        ],
      });
      const parsed = parseSideChoice(extractChatMessageText(msg.choices[0].message));
      if (parsed) votes.push(parsed);
    }
  }
  if (votes.length && votes.every((v) => v === votes[0])) {
    return { side: votes[0], source: "initial-model" };
  }
  const fallbackSide = deterministicSideFromKey(fallbackKey);
  console.warn(`  [debug] Using hash fallback for initial side: ${fallbackSide} (votes=${JSON.stringify(votes)})`);
  return { side: fallbackSide, source: "initial-model-hash-fallback" };
}

async function shouldSwitchSide(
  ai: OpenAI,
  persona: Persona,
  post: Record<string, unknown>,
  currentSide: Side,
  ownLastArg: Record<string, unknown>,
  opposingArgs: Record<string, unknown>[],
): Promise<boolean> {
  if (!opposingArgs.length) return false;

  const title = post.title ?? "";
  const body = post.body ?? "";
  const ownBody = toOneParagraph(String(ownLastArg.body ?? "")).slice(0, 1200);
  const opposingBlob = opposingArgs.slice(0, 3).map((arg, idx) => {
    const argBody = toOneParagraph(String(arg.body ?? "")).slice(0, 800);
    const author = String(arg.author ?? "unknown");
    return `Opposing argument ${idx + 1} by ${author}: ${argBody}`;
  }).join("\n\n");

  const decisions: Array<"switch" | "stay"> = [];
  for (let i = 0; i < SWITCH_DECISION_MAX_ATTEMPTS; i++) {
    const msg = await ai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: DECISION_MAX_COMPLETION_TOKENS,
      messages: [
        {
          role: "system",
          content:
            `${persona.prompt_style}\n\n` +
            `Decide if you should switch sides based on argument strength only. ` +
            `Return one token only: switch or stay.`,
        },
        {
          role: "user",
          content:
            `Debate title: ${title}\n\nDebate body: ${body}\n\n` +
            `Current side: ${currentSide}\n\n` +
            `Your last argument:\n${ownBody}\n\n` +
            `New opposing arguments:\n${opposingBlob}\n\n` +
            `If the opposing case is genuinely stronger and you are convinced, return switch. ` +
            `Otherwise return stay. Return exactly one token: switch or stay.`,
        },
      ],
    });
    const decision = parseSwitchDecision(extractChatMessageText(msg.choices[0].message));
    if (decision) decisions.push(decision);
  }
  if (decisions.length && decisions.every((d) => d === "switch")) return true;
  if (decisions.length) {
    console.warn(`  [debug] staying on current side (switch votes=${JSON.stringify(decisions)})`);
  } else {
    console.warn("  [debug] staying on current side (no parseable switch/stay votes)");
  }
  return false;
}

async function resolvePersonaSide(
  ai: OpenAI,
  sb: any,
  persona: Persona,
  post: Record<string, unknown>,
): Promise<{ side: Side; source: string; paulContext: string | null; mentionPaul: boolean }> {
  const postId = String(post.id ?? "");
  if (!postId) return { side: "for", source: "initial-model", paulContext: null, mentionPaul: false };

  if (persona.display_name === PAUL_NAME && isPaulAuthor(post.author)) {
    return { side: "for", source: "paul-authored-debate", paulContext: null, mentionPaul: false };
  }

  const ownLastArg = await getLastPersonaArgument(sb, postId, persona.display_name);
  if (ownLastArg) {
    const currentSide = normalizeSide(ownLastArg.side);
    if (currentSide) {
      const opposingArgs = await getRecentOpposingArguments(
        sb,
        postId,
        currentSide,
        persona.display_name,
        ownLastArg.createdat,
      );
      if (opposingArgs.length && await shouldSwitchSide(ai, persona, post, currentSide, ownLastArg, opposingArgs)) {
        return { side: oppositeSide(currentSide), source: "mind-change-switch", paulContext: null, mentionPaul: false };
      }
      return { side: currentSide, source: "stick-with-prior", paulContext: null, mentionPaul: false };
    }
  }

  if (isAthenaEquivalent(persona)) {
    return await resolveAthenaInitialSide(ai, sb, post);
  }
  const initial = await classifyInitialSide(ai, persona, post);
  return { side: initial.side, source: initial.source, paulContext: null, mentionPaul: false };
}

function toOneParagraph(text: unknown): string {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function buildFallbackArgument(side: Side, post: Record<string, unknown>): string {
  const title = String(post.title ?? "").trim() || "this debate";
  return toOneParagraph(
    `I take the ${side.toUpperCase()} side on "${title}" because the strongest evidence ` +
    `and incentives point that way. The opposing claim sounds plausible at first, ` +
    `but it fails once you test its real-world consequences.`,
  );
}

// ── Content generation ────────────────────────────────────────────────────────

async function generateArgument(
  ai: OpenAI,
  persona: Persona,
  post: Record<string, unknown>,
  side: Side,
  paulContext: string | null,
  mentionPaul: boolean,
): Promise<string> {
  const title = post.title ?? "";
  const body  = post.body ?? "";
  const rebuttalBlock = mentionPaul && paulContext
    ? `\n\n${PAUL_NAME}'s latest argument to rebut:\n${paulContext}\nAddress this directly and explain why it is wrong.`
    : "";
  const systemPrompt = isAthenaEquivalent(persona)
    ? `${persona.prompt_style}\n\nHard constraints:\n- Never cite Scripture, Bible verses, God, Jesus, church, or Christian doctrine.\n- Never invoke the Founders, natural law, or religious authority.\n- Stay analytical and strategic.`
    : persona.prompt_style;
  const request = {
    model: MODEL,
    max_completion_tokens: ARGUMENT_MAX_COMPLETION_TOKENS,
    messages: [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content:
          `You're arguing in this debate:\nTitle: ${title}\n\n${body}\n\n` +
          `You must argue the ${side.toUpperCase()} side. Do not switch sides.` +
          `${rebuttalBlock}\n\n` +
          `Write your argument in exactly one paragraph. No markdown. No headers. ` +
          `Argue hard. Make a real point. Be true to your character.`,
      },
    ],
  };

  for (let attempt = 1; attempt <= MODEL_EMPTY_RETRY_ATTEMPTS; attempt++) {
    const msg = await ai.chat.completions.create(request);
    const raw = extractChatMessageText(msg.choices[0].message);
    const paragraph = toOneParagraph(raw);
    if (paragraph.length >= 3) {
      return paragraph.slice(0, 5000);
    }
    console.warn(
      `  [warn] Empty argument body from model ` +
      `(attempt ${attempt}/${MODEL_EMPTY_RETRY_ATTEMPTS}).`,
    );
  }

  console.warn("  [warn] Using deterministic fallback argument body.");
  return buildFallbackArgument(side, post).slice(0, 5000);
}

async function generateNewPost(
  ai: OpenAI,
  persona: Persona,
): Promise<{ title: string; body: string }> {
  const msg = await ai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: NEW_POST_MAX_COMPLETION_TOKENS,
    messages: [
      { role: "system", content: persona.prompt_style },
      {
        role: "user",
        content:
          `Start a brand-new debate on a topic you genuinely care about. ` +
          `Pick something political, ethical, or social — something real and contentious. ` +
          `Format: first line is the TITLE only (no label), blank line, then exactly one paragraph. ` +
          `No markdown. Be opinionated. Don't be bland.`,
      },
    ],
  });
  const raw = extractChatMessageText(msg.choices[0].message).trim();
  if (!raw) throw new Error("Model returned an empty debate post body.");
  const allLines = raw.split("\n");
  let title = "";
  const bodyLines: string[] = [];
  let titleFound = false;
  for (const line of allLines) {
    if (!titleFound) { if (line.trim()) { title = line.trim(); titleFound = true; } }
    else bodyLines.push(line);
  }
  const bodyText = toOneParagraph(bodyLines.join("\n").trim() || raw);
  return { title: title || "A Debate Worth Having", body: bodyText };
}

async function incrementPostArgumentCounters(sb: any, postId: string, side: Side): Promise<void> {
  const { data: post, error: postErr } = await sb
    .from("posts")
    .select("argcount, forcount, againstcount")
    .eq("id", postId)
    .maybeSingle();
  if (postErr || !post) {
    if (postErr) console.warn(`  [warn] Could not fetch post counters for ${postId}: ${postErr.message}`);
    return;
  }

  const updates: Record<string, number> = {
    argcount: Number(post.argcount || 0) + 1,
  };
  if (side === "for") updates.forcount = Number(post.forcount || 0) + 1;
  if (side === "against") updates.againstcount = Number(post.againstcount || 0) + 1;

  const { error: updateErr } = await sb.from("posts").update(updates).eq("id", postId);
  if (updateErr) {
    console.warn(`  [warn] Could not update post counters for ${postId}: ${updateErr.message}`);
  }
}

function normalizeAction(raw: unknown): BotAction | null {
  const action = String(raw ?? "").trim().toLowerCase();
  return action === "argue" || action === "new" ? action : null;
}

function getPersonaFromRaw(raw: unknown): Persona | null {
  const key = String(raw ?? "").trim() as PersonaKey;
  if (!Object.prototype.hasOwnProperty.call(PERSONAS, key)) return null;
  return PERSONAS[key];
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

async function parseRequestedActionId(req: Request): Promise<number | null> {
  if (req.method !== "POST") return null;
  const contentType = String(req.headers.get("content-type") ?? "");
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    const body = await req.json() as Record<string, unknown>;
    const id = Number(body.actionId ?? body.action_id);
    if (Number.isInteger(id) && id > 0) return id;
  } catch {
    // No-op: allow empty/non-JSON body calls.
  }
  return null;
}

function hasValidCronSecret(req: Request): boolean {
  const configured = String(Deno.env.get("AGORIUM_BOT_CRON_SECRET") ?? "").trim();
  if (!configured) return false;
  const supplied = String(req.headers.get("x-agorium-bot-secret") ?? "").trim();
  return supplied.length > 0 && supplied === configured;
}

async function getPostById(
  sb: any,
  postId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await sb
    .from("posts")
    .select("*")
    .eq("id", postId)
    .maybeSingle();
  if (error) {
    console.warn(`  Could not load target post ${postId}: ${error.message}`);
    return null;
  }
  return (data as Record<string, unknown> | null) ?? null;
}

async function runArgumentAction(
  ai: OpenAI,
  sb: any,
  persona: Persona,
  post: Record<string, unknown>,
  forcedSideRaw: unknown,
): Promise<Record<string, unknown>> {
  const forcedSide = normalizeSide(forcedSideRaw);
  let side: Side;
  let sideSource = "forced-side";
  let paulContext: string | null = null;
  let mentionPaul = false;

  if (forcedSide) {
    side = forcedSide;
  } else {
    const resolution = await resolvePersonaSide(ai, sb, persona, post);
    side = resolution.side;
    sideSource = resolution.source;
    paulContext = resolution.paulContext;
    mentionPaul = resolution.mentionPaul;
  }

  console.log(`   Action: argue on "${post.title ?? post.id}"`);
  console.log(`   Side: ${side} (${sideSource})`);

  const body = await generateArgument(
    ai,
    persona,
    post,
    side,
    paulContext,
    mentionPaul,
  );
  if (body.trim().length < 3) {
    throw new Error("Generated argument body was empty.");
  }

  const argId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error } = await sb.from("arguments").insert({
    id: argId,
    postid: post.id,
    side,
    body,
    author: persona.display_name,
    createdat: now,
  });
  if (error) {
    throw new Error(`Failed to post argument: ${error.message}`);
  }

  await incrementPostArgumentCounters(sb, String(post.id), side);
  console.log(`✅ ${persona.display_name} argued (${side}) on: "${post.title ?? post.id}"`);
  return {
    action: "argue",
    persona: persona.display_name,
    post_id: post.id,
    post_title: post.title ?? null,
    side,
    side_source: sideSource,
    argument_id: argId,
  };
}

async function runNewDebateAction(
  ai: OpenAI,
  sb: any,
  persona: Persona,
): Promise<Record<string, unknown>> {
  console.log("   Action: new debate");
  const { title, body } = await generateNewPost(ai, persona);
  const postId = crypto.randomUUID();
  const now = new Date().toISOString();

  const { error } = await sb.from("posts").insert({
    id: postId,
    type: "debate",
    title,
    body,
    author: persona.display_name,
    createdat: now,
    tags: [],
  });
  if (error) {
    throw new Error(`Failed to create debate: ${error.message}`);
  }

  console.log(`✅ ${persona.display_name} started: "${title}"`);
  return {
    action: "new",
    persona: persona.display_name,
    post_id: postId,
    post_title: title,
  };
}

async function runBotAction(
  ai: OpenAI,
  sb: any,
  persona: Persona,
  action: BotAction,
  debateId: string | null,
  forcedSideRaw: unknown,
): Promise<Record<string, unknown>> {
  console.log(`\n🎭 Persona: ${persona.display_name}`);
  await ensurePersonaUser(sb, persona);

  if (action === "new") {
    return await runNewDebateAction(ai, sb, persona);
  }

  const postId = String(debateId ?? "").trim();
  if (!postId) {
    throw new Error("Argue action requires debate_id");
  }
  const post = await getPostById(sb, postId);
  if (!post) {
    throw new Error(`Debate not found: ${postId}`);
  }
  return await runArgumentAction(ai, sb, persona, post, forcedSideRaw);
}

async function claimPendingUiAction(
  sb: any,
  requestedId: number | null,
): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < BOT_UI_ACTION_MAX_CLAIM_ATTEMPTS; i++) {
    let query = sb
      .from("bot_ui_actions")
      .select("*")
      .eq("status", "pending");
    if (requestedId !== null) query = query.eq("id", requestedId);

    const { data, error } = await query
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      if (String(error.code) === "42P01") return null;
      console.warn(`  Could not query pending bot_ui_actions: ${error.message}`);
      return null;
    }
    if (!data) return null;

    const { data: claimed, error: claimErr } = await sb
      .from("bot_ui_actions")
      .update({
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
        error_text: null,
      })
      .eq("id", data.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();

    if (claimErr) {
      console.warn(`  Could not claim bot_ui_action ${data.id}: ${claimErr.message}`);
      if (requestedId !== null) return null;
      continue;
    }
    if (claimed) return claimed as Record<string, unknown>;
    if (requestedId !== null) return null;
  }
  return null;
}

async function getUiActionById(
  sb: any,
  actionId: number,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await sb
    .from("bot_ui_actions")
    .select("*")
    .eq("id", actionId)
    .maybeSingle();
  if (error) return null;
  return (data as Record<string, unknown> | null) ?? null;
}

async function markUiActionDone(
  sb: any,
  actionId: number,
  result: Record<string, unknown>,
): Promise<void> {
  const { error } = await sb
    .from("bot_ui_actions")
    .update({
      status: "done",
      finished_at: new Date().toISOString(),
      result,
      error_text: null,
    })
    .eq("id", actionId);
  if (error) {
    console.warn(`  Could not mark bot_ui_action ${actionId} done: ${error.message}`);
  }
}

async function markUiActionError(
  sb: any,
  actionId: number,
  message: string,
): Promise<void> {
  const { error } = await sb
    .from("bot_ui_actions")
    .update({
      status: "error",
      finished_at: new Date().toISOString(),
      error_text: String(message || "").slice(0, 1000),
    })
    .eq("id", actionId);
  if (error) {
    console.warn(`  Could not mark bot_ui_action ${actionId} error: ${error.message}`);
  }
}

async function runQueuedUiAction(
  ai: OpenAI,
  sb: any,
  actionRow: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const persona = getPersonaFromRaw(actionRow.persona);
  if (!persona) throw new Error(`Unknown persona in action row: ${actionRow.persona}`);

  const action = normalizeAction(actionRow.action);
  if (!action) throw new Error(`Unknown action in action row: ${actionRow.action}`);

  const debateId = String(actionRow.debate_id ?? "").trim() || null;
  return await runBotAction(
    ai,
    sb,
    persona,
    action,
    debateId,
    actionRow.forced_side,
  );
}

async function runAutopilotAction(
  ai: OpenAI,
  sb: any,
): Promise<Record<string, unknown>> {
  const keys = Object.keys(PERSONAS) as PersonaKey[];
  const persona = PERSONAS[keys[Math.floor(Math.random() * keys.length)]];

  const { data: posts, error } = await sb
    .from("posts")
    .select("*")
    .order("createdat", { ascending: false })
    .limit(10);
  if (error) throw new Error(`Could not load posts for autopilot: ${error.message}`);

  const useArgue = !!posts?.length && Math.random() < 0.7;
  if (useArgue && posts) {
    const target = posts.slice(0, 5)[Math.floor(Math.random() * Math.min(5, posts.length))];
    return await runBotAction(
      ai,
      sb,
      persona,
      "argue",
      String(target.id ?? ""),
      null,
    );
  }
  return await runBotAction(ai, sb, persona, "new", null, null);
}

// ── Entry point ───────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    console.log(`\n🤖 Agorium Bot — ${new Date().toUTCString()}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    const requestAuth = req.headers.get("authorization");

    const supabaseKey = supabaseServiceRoleKey || supabaseAnonKey;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase env vars (SUPABASE_URL and service role/anon key).");
    }

    // If service role is present, keep full service-role context (do not override
    // it with caller Authorization headers). Caller auth is only forwarded when
    // service-role key is unavailable.
    const forwardCallerAuth = !supabaseServiceRoleKey && !!requestAuth;
    const sb = createClient(supabaseUrl, supabaseKey, {
      global: forwardCallerAuth
        ? { headers: { Authorization: requestAuth! } }
        : undefined,
    });
    const requestedActionId = await parseRequestedActionId(req);

    const claimed = await claimPendingUiAction(sb, requestedActionId);
    if (claimed) {
      const actionId = Number(claimed.id);
      console.log(`\n🧾 Processing queued bot_ui_action #${actionId}`);
      if (!openaiKey) {
        const message = "Missing OPENAI_API_KEY secret for function runtime.";
        await markUiActionError(sb, actionId, message);
        return jsonResponse({
          ok: false,
          source: "queue",
          action_id: actionId,
          error: message,
        }, 500);
      }
      const ai = new OpenAI({ apiKey: openaiKey });
      try {
        const result = await runQueuedUiAction(ai, sb, claimed);
        await markUiActionDone(sb, actionId, result);
        return jsonResponse({
          ok: true,
          source: "queue",
          action_id: actionId,
          result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await markUiActionError(sb, actionId, message);
        return jsonResponse({
          ok: false,
          source: "queue",
          action_id: actionId,
          error: message,
        }, 500);
      }
    }

    if (requestedActionId !== null) {
      const existing = await getUiActionById(sb, requestedActionId);
      if (existing) {
        return jsonResponse({
          ok: true,
          source: "queue",
          action_id: requestedActionId,
          status: existing.status ?? "unknown",
          result: existing.result ?? null,
          error: existing.error_text ?? null,
        });
      }
      return jsonResponse({
        ok: false,
        source: "queue",
        action_id: requestedActionId,
        error: `Action ${requestedActionId} not found.`,
      }, 404);
    }

    if (!hasValidCronSecret(req)) {
      return jsonResponse({
        ok: false,
        error: "Manual invoke requires actionId. Autopilot requires x-agorium-bot-secret.",
      }, 401);
    }

    if (!openaiKey) {
      throw new Error("Missing OPENAI_API_KEY secret for function runtime.");
    }
    const ai = new OpenAI({ apiKey: openaiKey });
    const result = await runAutopilotAction(ai, sb);
    return jsonResponse({ ok: true, source: "autopilot", result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(err);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
