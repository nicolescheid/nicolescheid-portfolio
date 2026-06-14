# Model-routing layer for `/chat`

A Haiku-classifier router: a small, fast `claude-haiku-4-5` call sorts each
user prompt into a tier, then the request is dispatched to the matching model.

```
prompt ──▶ classifyTier()  ──▶ route to tier model ──▶ answer
            [Haiku, ~$0.0001]      light / mid / heavy
```

| Tier  | Model              | Context | $/1M in | $/1M out | For… |
|-------|--------------------|--------:|--------:|---------:|------|
| light | `claude-haiku-4-5` | 200K    | $1      | $5       | greetings, simple lookups, short rewrites |
| mid   | `claude-sonnet-4-6`| 1M      | $3      | $15      | general chat, summarizing, everyday coding |
| heavy | `claude-opus-4-8`  | 1M      | $5      | $25      | hard reasoning, big code changes, agentic work |

> **Status:** portable reference module. It lives outside `public/`, so it has
> **no effect on the deployed homepage** (`wrangler` only serves `./public`).
> Drop `router.js` into the actual `/chat` Worker to wire it in.

## Wiring into the chat Worker

```js
import { route } from "./router.js";

export default {
  async fetch(request, env) {
    if (request.method === "POST" && new URL(request.url).pathname === "/chat/api") {
      const { messages } = await request.json();
      return route(messages, env.ANTHROPIC_API_KEY, {
        stream: true,
        system: "You are Nicole's site assistant. …",
      });
    }
    // … existing routes / static handling
  },
};
```

The response carries `X-Model-Tier`, `X-Model-Id`, and `X-Route-Reason` headers
so the front end can show which model answered (and why).

## Notes & knobs

- **Classifier never blocks the chat.** Any error or non-200 from the Haiku
  call falls back to the `mid` tier.
- **Cost control.** The classifier only reads the first ~4 KB of the latest user
  message plus a thread-depth hint — a few hundred tokens, a fraction of a cent
  per turn. The answer call pays normal rates for the chosen tier.
- **Depth-aware.** The classifier is told how many prior user turns the thread
  has, so a conversation that escalates in difficulty routes up even when the
  latest message looks simple on its own.
- **Per-tier tuning** lives in `TIERS` in `router.js`: model, `max_tokens`, and
  whether to enable adaptive thinking (on for `heavy` / Opus only by default).
- **Tune the rubric** in `ROUTER_SYSTEM` to match how you want spend split.

## Possible follow-ups

- **Collapse classify+answer for light prompts:** when the classifier would pick
  `light`, you've already paid for a Haiku round trip — you could have that same
  call answer directly and save the second request. Kept separate here for
  clarity; easy to add.
- **User override:** let the UI force a tier (e.g. a "think harder" toggle) that
  skips the classifier.
- **Telemetry:** log `{tier, reason, tokens}` to confirm the split lands where
  you expect before trusting it on spend.
