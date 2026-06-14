// Model-routing layer for the /chat Cloudflare Worker.
//
// A small, fast Haiku call classifies each user prompt into a tier, then the
// request is dispatched to the matching model. Portable, dependency-free
// (uses fetch + the raw Anthropic Messages API), so it drops into any Worker.
//
// Flow:   prompt --> classifyTier() [Haiku] --> answer() [tier model]
//
// Wire-up: call route() from your Worker's fetch handler. See README.md.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// The three tiers. Tune max_tokens / thinking per tier to taste.
// Model IDs are current as of 2026-06; bump them as new models ship.
export const TIERS = {
  light: {
    model: "claude-haiku-4-5", // 200K ctx, $1/$5 per 1M
    max_tokens: 2048,
    thinking: null, // fast path — no extended thinking
  },
  mid: {
    model: "claude-sonnet-4-6", // 1M ctx, $3/$15 per 1M
    max_tokens: 8192,
    thinking: null,
  },
  heavy: {
    model: "claude-opus-4-8", // 1M ctx, $5/$25 per 1M
    max_tokens: 32000,
    thinking: { type: "adaptive" }, // let Opus think on the hard ones
  },
};

const CLASSIFIER_MODEL = "claude-haiku-4-5";

const ROUTER_SYSTEM = `You are a routing classifier for a chat assistant. Pick the cheapest model tier that will handle the user's latest message well. Do NOT answer the message — only classify it.

Tiers:
- "light": greetings, small talk, simple factual lookups, short rewrites, yes/no or single-fact answers, basic formatting. Anything a small model nails instantly.
- "mid": general conversation, summarization, explanation, everyday coding, drafting, moderate reasoning that's still single-step or lightly multi-step.
- "heavy": multi-step reasoning or planning, hard math/proofs, large or subtle code changes and debugging, long-horizon/agentic tasks, careful analysis where a wrong answer is costly, or anything the running conversation has clearly escalated in difficulty.

When unsure between two tiers, pick the lower one — escalation is cheap to add later, wasted Opus calls are not. But if the message shows real reasoning depth, don't under-route it.

Consider the conversation depth hint: a thread that has gone many turns on the same hard problem usually warrants a higher tier than the message alone suggests.`;

const TIER_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: ["light", "mid", "heavy"] },
    reason: { type: "string" },
  },
  required: ["tier", "reason"],
  additionalProperties: false,
};

/**
 * Pull the latest user message text out of a messages array.
 * Handles both string content and content-block arrays.
 */
function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
  }
  return "";
}

/**
 * Classify the conversation into a tier with a cheap Haiku call.
 * Returns { tier, reason }. Falls back to "mid" if anything goes wrong —
 * never let a classifier hiccup take down the chat.
 */
export async function classifyTier(messages, apiKey, { fetchImpl = fetch } = {}) {
  const userText = latestUserText(messages);
  const priorTurns = messages.filter((m) => m.role === "user").length - 1;

  // Cap the classifier input so a giant pasted prompt doesn't cost real money
  // just to be classified — the first chunk is plenty of signal.
  const snippet = userText.slice(0, 4000);
  const depthHint =
    priorTurns > 0
      ? `\n\n[conversation depth: ${priorTurns} prior user turn(s) in this thread]`
      : "";

  try {
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 256,
        system: ROUTER_SYSTEM,
        output_config: {
          format: { type: "json_schema", schema: TIER_SCHEMA },
        },
        messages: [{ role: "user", content: snippet + depthHint }],
      }),
    });

    if (!res.ok) return { tier: "mid", reason: `classifier ${res.status}; defaulted to mid` };

    const data = await res.json();
    const text = (data.content || []).find((b) => b.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text);
    if (!TIERS[parsed.tier]) return { tier: "mid", reason: "unknown tier; defaulted to mid" };
    return { tier: parsed.tier, reason: parsed.reason ?? "" };
  } catch (err) {
    return { tier: "mid", reason: `classifier error: ${err?.message ?? err}; defaulted to mid` };
  }
}

/**
 * Classify, then answer with the chosen tier's model.
 *
 * @param {Array} messages   Anthropic-format messages (the conversation).
 * @param {string} apiKey    ANTHROPIC_API_KEY.
 * @param {object} opts
 *   @param {boolean} opts.stream   Stream the answer as SSE (default true).
 *   @param {string}  opts.system   System prompt for the answer call.
 *   @param {function} opts.fetchImpl  Override fetch (for tests).
 * @returns {Response}  The Anthropic answer response, with X-Model-Tier /
 *                       X-Model-Id headers added so the UI can show which
 *                       model replied. Streaming bodies are passed through.
 */
export async function route(messages, apiKey, opts = {}) {
  const { stream = true, system, fetchImpl = fetch } = opts;

  const { tier, reason } = await classifyTier(messages, apiKey, { fetchImpl });
  const cfg = TIERS[tier];

  const body = {
    model: cfg.model,
    max_tokens: cfg.max_tokens,
    messages,
    stream,
  };
  if (system) body.system = system;
  if (cfg.thinking) body.thinking = cfg.thinking;

  const upstream = await fetchImpl(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  // Pass the body straight through (works for both streamed SSE and JSON),
  // tagging the chosen tier so the front end can surface it.
  const headers = new Headers(upstream.headers);
  headers.set("X-Model-Tier", tier);
  headers.set("X-Model-Id", cfg.model);
  headers.set("X-Route-Reason", reason.slice(0, 256));

  return new Response(upstream.body, { status: upstream.status, headers });
}
