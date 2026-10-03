import { HttpStatus } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderHttpError } from "../providers/base.provider";
import { UpstreamTimeoutError } from "../providers/upstream-timeout";
import { ModelRuntimeException } from "../runtime/runtime.errors";
import {
  classifyFailure,
  upstreamHealth,
  type HealthStore,
  type RouteDef,
  type Transition,
} from "./upstream-health";

const DOUBAO_SET_LIMIT =
  '{"error":{"code":"SetLimitExceeded","message":"Your account has reached the set usage limit","type":"TooManyRequests"}}';

describe("classifyFailure - what a failed call says about the vendor", () => {
  it.each([
    ["402 balance", new ProviderHttpError("x", 402, "p", "Insufficient Balance"), "account"],
    ["401 key", new ProviderHttpError("x", 401, "p", ""), "account"],
    ["403", new ProviderHttpError("x", 403, "p", ""), "account"],
    ["429 account cap", new ProviderHttpError("x", 429, "p", DOUBAO_SET_LIMIT), "account"],
    ["429 throttling", new ProviderHttpError("x", 429, "p", "{}"), "rate_limited"],
    ["404 model", new ProviderHttpError("x", 404, "p", ""), "model_missing"],
    ["503", new ProviderHttpError("x", 503, "p", ""), "unavailable"],
    ["timeout", new UpstreamTimeoutError("p", 30_000), "unavailable"],
    ["network", new TypeError("fetch failed"), "unreachable"],
  ] as const)("%s -> %s", (_name, error, signal) => {
    expect(classifyFailure(error)).toBe(signal);
  });

  it.each([
    ["the request's content (400)", new ProviderHttpError("x", 400, "p", "too long"), undefined],
    ["Atlas's own refusal", new ModelRuntimeException(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED", "gate"), undefined],
  ])("says nothing about the vendor: %s", (_name, error, code) => {
    expect(classifyFailure(error, code)).toBeUndefined();
  });

  it("ignores the caller's deadline even when the cancellation looks like an error", () => {
    expect(classifyFailure(new Error("aborted"), "DEADLINE_EXCEEDED")).toBeUndefined();
  });
});

class FakeStore implements HealthStore {
  saved: Transition[] = [];
  constructor(
    public routes: RouteDef[],
    private readonly preloaded: Awaited<ReturnType<HealthStore["load"]>> = { models: [], routes: [] },
  ) {}
  async load() {
    return this.preloaded;
  }
  async listRoutes() {
    return this.routes;
  }
  async save(t: Transition) {
    this.saved.push(t);
  }
}

const CHAT_FAST: RouteDef = { code: "chat/fast", primary: "doubao-lite", fallback: "deepseek-flash" };

describe("upstreamHealth - transitions reach the store, calls do not", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 1_000_000;
    upstreamHealth.resetForTests(() => clock);
  });
  afterEach(() => upstreamHealth.resetForTests());

  it("replays the evening of 2026-10-01: degraded when the primary fails, down - critical - when the fallback fails too", async () => {
    const store = new FakeStore([CHAT_FAST]);
    await upstreamHealth.attach(store);

    upstreamHealth.recordFailure("doubao-lite", "doubao", new ProviderHttpError("x", 429, "p", DOUBAO_SET_LIMIT));
    upstreamHealth.recordFailure("deepseek-flash", "deepseek", new ProviderHttpError("x", 402, "p", "Insufficient Balance"));
    // More failures change nothing: one event per transition, not per call.
    for (let i = 0; i < 20; i += 1) {
      upstreamHealth.recordFailure("deepseek-flash", "deepseek", new ProviderHttpError("x", 402, "p", "Insufficient Balance"));
    }
    await upstreamHealth.flushed();

    const events = store.saved.filter((t) => t.event);
    expect(events.map((t) => `${t.subjectKind}:${t.subjectKey} ${t.from}->${t.to} ${t.severity}`)).toEqual([
      "model:doubao-lite unknown->account_refused warning",
      "route:chat/fast ok->degraded warning",
      "model:deepseek-flash unknown->account_refused warning",
      "route:chat/fast degraded->down critical",
    ]);
    const deepseek = events.find((t) => t.subjectKey === "deepseek-flash");
    expect(deepseek).toMatchObject({ upstreamStatus: 402, detail: "Insufficient Balance", affectedRoutes: ["chat/fast"] });
  });

  it("an operator clearing the fallback of a route whose primary is failing makes it down - an event, with no model changing", async () => {
    const store = new FakeStore([CHAT_FAST]);
    await upstreamHealth.attach(store);
    upstreamHealth.recordFailure("doubao-lite", "doubao", new ProviderHttpError("x", 429, "p", DOUBAO_SET_LIMIT));
    upstreamHealth.recordSuccess("deepseek-flash", "deepseek");
    await upstreamHealth.flushed();
    expect(store.saved.filter((t) => t.subjectKind === "route").map((t) => t.to)).toEqual(["degraded"]);

    store.routes = [{ ...CHAT_FAST, fallback: null }];
    await upstreamHealth.syncRoutes();

    expect(store.saved.at(-1)).toMatchObject({
      subjectKind: "route",
      subjectKey: "chat/fast",
      from: "degraded",
      to: "down",
      severity: "critical",
      event: true,
    });
    // Nothing changed since: the next sync writes nothing.
    const count = store.saved.length;
    await upstreamHealth.syncRoutes();
    expect(store.saved).toHaveLength(count);
  });

  it("a recovery is an event too, and the route comes back", async () => {
    const store = new FakeStore([CHAT_FAST]);
    await upstreamHealth.attach(store);
    upstreamHealth.recordFailure("doubao-lite", "doubao", new ProviderHttpError("x", 402, "p", ""));
    upstreamHealth.recordFailure("deepseek-flash", "deepseek", new ProviderHttpError("x", 402, "p", ""));
    upstreamHealth.recordSuccess("deepseek-flash", "deepseek");
    await upstreamHealth.flushed();

    const tail = store.saved.filter((t) => t.event).slice(-2);
    expect(tail.map((t) => `${t.subjectKey} ${t.from}->${t.to} ${t.severity}`)).toEqual([
      "deepseek-flash account_refused->ok info",
      "chat/fast down->degraded warning",
    ]);
  });

  it("the first sighting of a healthy model is stored quietly, without an event", async () => {
    const store = new FakeStore([CHAT_FAST]);
    await upstreamHealth.attach(store);
    upstreamHealth.recordSuccess("doubao-lite", "doubao");
    await upstreamHealth.flushed();

    expect(store.saved).toEqual([expect.objectContaining({ subjectKey: "doubao-lite", to: "ok", event: false })]);
  });

  it("restores durable state at start, without overwriting what was seen since", async () => {
    clock = 5;
    upstreamHealth.recordSuccess("seen-live", "doubao");
    const store = new FakeStore([], {
      models: [
        { modelCode: "seen-live", providerCode: "doubao", record: { state: "account_refused", since: 1, consecutiveFailures: 0 } },
        { modelCode: "deepseek-flash", providerCode: "deepseek", record: { state: "account_refused", since: 1, consecutiveFailures: 0 } },
      ],
      routes: [],
    });
    await upstreamHealth.attach(store);

    expect(upstreamHealth.modelState("seen-live")).toBe("ok");
    expect(upstreamHealth.modelState("deepseek-flash")).toBe("account_refused");
  });

  it("a store that fails is counted, and does not break the call path", async () => {
    const store = new FakeStore([CHAT_FAST]);
    store.save = async () => {
      throw new Error("db down");
    };
    await upstreamHealth.attach(store);
    expect(() =>
      upstreamHealth.recordFailure("doubao-lite", "doubao", new ProviderHttpError("x", 402, "p", "")),
    ).not.toThrow();
    await upstreamHealth.flushed();
    expect(upstreamHealth.modelState("doubao-lite")).toBe("account_refused");
  });
});
