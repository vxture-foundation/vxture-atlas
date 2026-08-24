#!/usr/bin/env node
/**
 * stub-upstream.mjs - a DeepSeek-V4-shaped thinking model, for verifying the
 * probe without a vendor credential.
 *
 * WHY THIS EXISTS. `POST /capability/models/:id/probe` is the one route whose
 * correctness can only be judged against a real upstream response, and the
 * responses that matter most are the awkward ones: a model that burns its whole
 * output budget on a reasoning chain and answers nothing. Reproducing that
 * against a live vendor costs money, needs a credential this machine may not
 * have, and is not reproducible - the model may simply answer next time.
 *
 * So the awkward response is served locally. Default behaviour reproduces the
 * failure verbatim: thinking on, budget exhausted, `content: ""` with
 * `finish_reason: "length"` on the non-streaming call, and a stream carrying
 * nothing but `delta.reasoning_content`. That second one is the case the probe
 * used to report GREEN - HTTP 200, usage complete, not one deliverable token -
 * while a real caller got an empty stream.
 *
 * Send `thinking: {"type": "disabled"}` and it answers normally. That is the
 * half that proves `wire.extraBody` reaches the wire, rather than being a
 * registry key nothing reads.
 *
 * The numbers are not invented. `prompt_tokens: 84` / `completion_tokens: 16`
 * and the cache/reasoning splits are what api.deepseek.com actually returned
 * for `{"messages":[{"role":"user","content":"ping"}],"max_tokens":16}` on
 * 2026-08-24 - which is also where the "100 tokens" in the original bug report
 * came from.
 *
 * Every request body is recorded and served back at GET /_requests, so the
 * probe's own request - max_tokens, stream_options, extraBody passthrough - can
 * be asserted rather than assumed.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const seen = [];

const REASONING = "Let me think about what ping means. ".repeat(6);

/** Verbatim from api.deepseek.com, 2026-08-24. */
function usage() {
  return {
    prompt_tokens: 84,
    completion_tokens: 16,
    total_tokens: 100,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 16 },
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 84,
  };
}

function nonStream(thinking) {
  const message = thinking
    ? { role: "assistant", content: "", reasoning_content: REASONING }
    : { role: "assistant", content: "pong" };

  return {
    id: "stub-1",
    choices: [
      { index: 0, message, finish_reason: thinking ? "length" : "stop" },
    ],
    usage: usage(),
  };
}

function sse(res, thinking) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

  if (thinking) {
    // Nothing but reasoning. No text delta ever arrives - this is the shape the
    // probe has to call a failure.
    for (const part of ["Let me ", "think about ", "ping."]) {
      frame({
        id: "stub-1",
        choices: [{ index: 0, delta: { reasoning_content: part } }],
      });
    }
  } else {
    for (const part of ["po", "ng"]) {
      frame({ id: "stub-1", choices: [{ index: 0, delta: { content: part } }] });
    }
  }

  frame({
    id: "stub-1",
    choices: [
      { index: 0, delta: {}, finish_reason: thinking ? "length" : "stop" },
    ],
  });
  frame({ id: "stub-1", choices: [], usage: usage() });
  res.write("data: [DONE]\n\n");
  res.end();
}

createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/_requests")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(seen, null, 2));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/healthz")) {
    res.writeHead(200).end("ok");
    return;
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      // Recorded below either way - an unparseable body is itself a finding.
    }
    seen.push({
      path: req.url,
      auth: Boolean(req.headers.authorization),
      body,
    });

    const thinking = body?.thinking?.type !== "disabled";
    if (body.stream) {
      sse(res, thinking);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(nonStream(thinking)));
  });
}).listen(PORT, () => console.log(`stub upstream listening on ${PORT}`));
