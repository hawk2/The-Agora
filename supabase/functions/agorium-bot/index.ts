import OpenAI from "npm:openai";
import { createClient } from "npm:@supabase/supabase-js";

const MODEL = "gpt-5-mini-2025-08-07";
const SIDES = ["for", "against"] as const;
const PAUL_NAME = "RighteousPaul";
type Side = (typeof SIDES)[number];
const PREDICT_SIDE_MAX_ATTEMPTS = 3;
const SIDE_CLASSIFY_MAX_ATTEMPTS = 3;
const SWITCH_DECISION_MAX_ATTEMPTS = 3;

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
        max_completion_tokens: 32,
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
      const parsed = parseSideChoice(msg.choices[0].message.content);
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
        max_completion_tokens: 32,
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
      const parsed = parseSideChoice(msg.choices[0].message.content);
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
      max_completion_tokens: 32,
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
    const decision = parseSwitchDecision(msg.choices[0].message.content);
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
  const msg = await ai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 700,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `You're arguing in this debate:\nTitle: ${title}\n\n${body}\n\n` +
          `You must argue the ${side.toUpperCase()} side. Do not switch sides.` +
          `${rebuttalBlock}\n\n` +
          `Write your argument in exactly one paragraph. No markdown. No headers. ` +
          `Argue hard. Make a real point. Be true to your character.`,
      },
    ],
  });
  return toOneParagraph(msg.choices[0].message.content);
}

async function generateNewPost(
  ai: OpenAI,
  persona: Persona,
): Promise<{ title: string; body: string }> {
  const msg = await ai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 700,
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
  const raw = msg.choices[0].message.content!.trim();
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

// ── Entry point ───────────────────────────────────────────────────────────────

Deno.serve(async (_req) => {
  try {
    console.log(`\n🤖 Agorium Bot — ${new Date().toUTCString()}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openaiKey   = Deno.env.get("OPENAI_API_KEY")!;

    const sb = createClient(supabaseUrl, supabaseKey);
    const ai = new OpenAI({ apiKey: openaiKey });

    // Pick persona
    const keys = Object.keys(PERSONAS) as PersonaKey[];
    const persona = PERSONAS[keys[Math.floor(Math.random() * keys.length)]];
    console.log(`\n🎭 Persona: ${persona.display_name}`);

    // Ensure user exists
    await ensurePersonaUser(sb, persona);

    // Fetch recent posts
    const { data: posts } = await sb
      .from("posts")
      .select("*")
      .order("createdat", { ascending: false })
      .limit(10);

    const now = new Date().toISOString();

    if (posts?.length && Math.random() < 0.7) {
      // 70%: argue in an existing debate
      const target = posts.slice(0, 5)[Math.floor(Math.random() * Math.min(5, posts.length))];
      console.log(`   Action: argue on "${target.title ?? target.id}"`);

      const resolution = await resolvePersonaSide(ai, sb, persona, target as Record<string, unknown>);
      const side = resolution.side;
      const sideSource = resolution.source;
      const paulContext = resolution.paulContext;
      const mentionPaul = resolution.mentionPaul;
      console.log(`   Side: ${side} (${sideSource})`);

      const body = await generateArgument(
        ai,
        persona,
        target as Record<string, unknown>,
        side,
        paulContext,
        mentionPaul,
      );

      const { error } = await sb.from("arguments").insert({
        id:        crypto.randomUUID(),
        postid:    target.id,
        side,
        body,
        author:    persona.display_name,
        createdat: now,
      });

      if (error) console.error(`❌ Failed to post argument: ${error.message}`);
      else {
        await incrementPostArgumentCounters(sb, String(target.id), side);
        console.log(`✅ ${persona.display_name} argued (${side}) on: "${target.title ?? target.id}"`);
      }
    } else {
      // 30%: start a new debate
      console.log("   Action: new debate");
      const { title, body } = await generateNewPost(ai, persona);

      const { error } = await sb.from("posts").insert({
        id:        crypto.randomUUID(),
        type:      "debate",
        title,
        body,
        author:    persona.display_name,
        createdat: now,
        tags:      [],
      });

      if (error) console.error(`❌ Failed to create debate: ${error.message}`);
      else console.log(`✅ ${persona.display_name} started: "${title}"`);
    }

    return new Response("✅ Done", { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(`Error: ${err}`, { status: 500 });
  }
});
