import { describe, it, expect, vi } from "vitest";

import { ModelAdminService } from "./model-admin.service";
import {
  ANTHROPIC_WIRE_DEFAULTS,
  OPENAI_WIRE_DEFAULTS,
  WIRE_SCHEMA_VERSION,
} from "../providers/wire";
import { ModelAdminException } from "./model-admin.errors";
import { metricsRegistry } from "./metrics.registry";
import type {
  CreateAiModelBody,
  CreateAiModelGrantBody,
  CreateModelEndpointBody,
  CreateModelPolicyBody,
  CreateModelPriceRuleBody,
  CreateModelProviderBody,
  UpdateAiModelBody,
  UpdateAiModelGrantBody,
  UpdateModelProviderBody,
} from "./model-admin.service";
import type { ModelRegistryRepository } from "../registry/model-registry.repository";
import type {
  AiModelRecord,
  ModelEndpointRecord,
  ModelProviderRecord,
  TenantUsageSummaryRecord,
} from "../types/runtime.types";

// ── helpers ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = new ModelAdminService(null as any);

const normalizeCreate = (body: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).normalizeCreateModel(body) as ReturnType<
    ModelAdminService["createModel"]
  >;
const normalizeUpdate = (body: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).normalizeUpdateModel(body) as ReturnType<
    ModelAdminService["updateModel"]
  >;
const normalizeUpdateGrant = (body: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).normalizeUpdateGrant(body) as ReturnType<
    ModelAdminService["updateGrant"]
  >;
const normalizeCreateProvider = (body: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).normalizeCreateProvider(body) as unknown;

const VALID_BASE: CreateAiModelBody = {
  modelCode: "gpt-4o",
  modelName: "GPT-4o",
  provider: "openai",
  endpointUrl: "https://api.openai.com/v1",
  protocol: "openai",
  capabilities: ["chat"],
};

// ── protocol vocabulary + wire descriptor (P2) ────────────────────────────────

describe("protocol validation on write", () => {
  it("normalizes a legacy alias to its canonical value on create", () => {
    // 现网存量就是 `openai`/`anthropic` 两个别名 - 拒绝它们会让运营改一个
    // 无关字段时被绊住；归一化写回则让数据自己收敛。
    expect(normalizeCreate({ ...VALID_BASE, protocol: "openai" })).toMatchObject(
      { protocol: "openai-chat-completions" },
    );
    expect(
      normalizeCreate({ ...VALID_BASE, protocol: "anthropic" }),
    ).toMatchObject({ protocol: "anthropic-messages" });
  });

  it("normalizes on update too", () => {
    expect(normalizeUpdate({ protocol: "  CLAUDE  " })).toMatchObject({
      protocol: "anthropic-messages",
    });
  });

  it("rejects a protocol outside the vocabulary", () => {
    // protocol 是分发键，不是自由文本 - 一个拼错的值会让模型不可路由。
    expect(() =>
      normalizeCreate({ ...VALID_BASE, protocol: "doubao" }),
    ).toThrow(ModelAdminException);
  });

  it("still requires protocol to be present", () => {
    const body = { ...VALID_BASE };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (body as any).protocol;
    expect(() => normalizeCreate(body)).toThrow(ModelAdminException);
  });
});

describe("config.wire validation on write", () => {
  it("accepts a valid descriptor", () => {
    expect(
      normalizeCreate({
        ...VALID_BASE,
        config: { wire: { streamUsage: "none", supports: { tools: false } } },
      }),
    ).toMatchObject({
      config: { wire: { streamUsage: "none" } },
    });
  });

  it("rejects an unknown wire key rather than silently ignoring it", () => {
    expect(() =>
      normalizeCreate({ ...VALID_BASE, config: { wire: { streamUsge: "none" } } }),
    ).toThrow(ModelAdminException);
  });

  it("rejects an out-of-vocabulary wire value", () => {
    expect(() =>
      normalizeCreate({
        ...VALID_BASE,
        config: { wire: { streamUsage: "carrier-pigeon" } },
      }),
    ).toThrow(ModelAdminException);
  });

  it("applies to provider config as well as model config", () => {
    expect(() =>
      normalizeCreateProvider({
        providerCode: "deepseek",
        providerName: "DeepSeek",
        config: { wire: { auth: { style: "magic" } } },
      }),
    ).toThrow(ModelAdminException);
  });

  it("leaves a config without a wire block alone", () => {
    expect(
      normalizeCreate({ ...VALID_BASE, config: { upstreamModel: "gpt-4o" } }),
    ).toMatchObject({ config: { upstreamModel: "gpt-4o" } });
  });
});

describe("getProtocolCatalog", () => {
  it("lists every protocol with its aliases and wire defaults", () => {
    const catalog = svc.getProtocolCatalog();

    expect(catalog.protocols.map((p) => p.protocol)).toEqual([
      "openai-chat-completions",
      "anthropic-messages",
    ]);
    expect(catalog.wireSchemaVersion).toBeGreaterThanOrEqual(1);
  });

  it("exposes the defaults the adapters actually use", () => {
    const catalog = svc.getProtocolCatalog();
    const openai = catalog.protocols.find(
      (p) => p.protocol === "openai-chat-completions",
    );
    const anthropic = catalog.protocols.find(
      (p) => p.protocol === "anthropic-messages",
    );

    expect(openai?.wireDefaults.streamUsage).toBe("stream_options");
    expect(anthropic?.wireDefaults.streamUsage).toBe("native");
    expect(openai?.aliases).toContain("openai");
  });

  it("presents knownUpstreams as a hint, not a closed list", () => {
    // 词表按线格式定义 - 任何讲这套方言的上游都能用，不在列表里也能接。
    const catalog = svc.getProtocolCatalog();
    const openai = catalog.protocols.find(
      (p) => p.protocol === "openai-chat-completions",
    );

    expect(openai?.knownUpstreams).toContain("deepseek");
    expect(() =>
      normalizeCreate({ ...VALID_BASE, provider: "some-new-vendor" }),
    ).not.toThrow();
  });
});

// ── normalizeCreateModel ──────────────────────────────────────────────────────

describe("normalizeCreateModel", () => {
  describe("required field validation", () => {
    it("throws when capabilities is absent", () => {
      const body = { ...VALID_BASE };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (body as any).capabilities;
      expect(() => normalizeCreate(body)).toThrow(ModelAdminException);
    });

    it("throws when capabilities is not an array", () => {
      expect(() =>
        normalizeCreate({ ...VALID_BASE, capabilities: "chat" }),
      ).toThrow(ModelAdminException);
    });

    it("throws when capabilities is empty after filtering", () => {
      expect(() =>
        normalizeCreate({ ...VALID_BASE, capabilities: [] }),
      ).toThrow(ModelAdminException);
    });

    it("throws when capabilities contains only whitespace strings", () => {
      expect(() =>
        normalizeCreate({ ...VALID_BASE, capabilities: ["  ", ""] }),
      ).toThrow(ModelAdminException);
    });

    it("throws when modelCode is missing", () => {
      expect(() => normalizeCreate({ ...VALID_BASE, modelCode: "" })).toThrow(
        ModelAdminException,
      );
    });

    it("throws when modelCode is whitespace", () => {
      expect(() => normalizeCreate({ ...VALID_BASE, modelCode: "  " })).toThrow(
        ModelAdminException,
      );
    });

    it("throws when modelName is missing", () => {
      expect(() => normalizeCreate({ ...VALID_BASE, modelName: "" })).toThrow(
        ModelAdminException,
      );
    });

    it("throws when provider is missing", () => {
      expect(() => normalizeCreate({ ...VALID_BASE, provider: "" })).toThrow(
        ModelAdminException,
      );
    });

    it("throws when endpointUrl is not a valid URL", () => {
      expect(() =>
        normalizeCreate({ ...VALID_BASE, endpointUrl: "not-a-url" }),
      ).toThrow(ModelAdminException);
    });

    it("throws when protocol is missing", () => {
      expect(() => normalizeCreate({ ...VALID_BASE, protocol: "" })).toThrow(
        ModelAdminException,
      );
    });
  });

  describe("defaults", () => {
    it('defaults modelType to "chat"', () => {
      const result = normalizeCreate(VALID_BASE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).modelType).toBe("chat");
    });

    it("defaults supportsStreaming to true", () => {
      const result = normalizeCreate(VALID_BASE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).supportsStreaming).toBe(true);
    });

    it("defaults sort to 999", () => {
      const result = normalizeCreate(VALID_BASE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).sort).toBe(999);
    });

    it("defaults description to null", () => {
      const result = normalizeCreate(VALID_BASE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).description).toBeNull();
    });

    it("defaults contextWindow to null", () => {
      const result = normalizeCreate(VALID_BASE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).contextWindow).toBeNull();
    });

    it("defaults config to null", () => {
      const result = normalizeCreate(VALID_BASE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).config).toBeNull();
    });

    // ADR-003 made the vault the store; 2026-08-17 made it the ONLY source.
    // These two used to assert that an env-var key name was written into the
    // model config - a reference the call path no longer reads, so accepting
    // it would leave an operator believing a key was set.
    it("refuses the retired apiKeyEnvVar input instead of ignoring it", () => {
      expect(() =>
        normalizeCreate({ ...VALID_BASE, apiKeyEnvVar: "TEST_MODEL_KEY" }),
      ).toThrow(/apiKeyEnvVar is retired/);
    });

    it("refuses keyReference.source env, naming the replacement", () => {
      expect(() =>
        normalizeCreate({
          ...VALID_BASE,
          keyReference: { source: "env", name: "TEST_MODEL_KEY" },
        }),
      ).toThrow(/must be "managed"/);
    });

    it("maps a managed keyReference into runtime config", () => {
      const result = normalizeCreate({
        ...VALID_BASE,
        keyReference: { source: "managed", name: "zhipu-primary" },
        config: { fallbackModelCodes: ["backup-model"] },
        providerConfig: null,
        providerActive: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).config).toEqual({
        fallbackModelCodes: ["backup-model"],
        managedKeyAlias: "zhipu-primary",
      });
    });

    it("defaults an omitted source to managed, not to the retired env", () => {
      // The trap this closes: `source` used to default to "env", so an
      // operator who omitted it configured a key the runtime cannot resolve.
      const result = normalizeCreate({
        ...VALID_BASE,
        keyReference: { name: "zhipu-primary" },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).config).toEqual({ managedKeyAlias: "zhipu-primary" });
    });
  });

  describe("explicit values", () => {
    it("uses provided modelType", () => {
      const result = normalizeCreate({ ...VALID_BASE, modelType: "embedding" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).modelType).toBe("embedding");
    });

    it("uses provided supportsStreaming=false", () => {
      const result = normalizeCreate({
        ...VALID_BASE,
        supportsStreaming: false,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).supportsStreaming).toBe(false);
    });

    it("uses provided sort", () => {
      const result = normalizeCreate({ ...VALID_BASE, sort: 1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).sort).toBe(1);
    });

    it("accepts contextWindow=0", () => {
      const result = normalizeCreate({ ...VALID_BASE, contextWindow: 0 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).contextWindow).toBe(0);
    });

    it("throws when contextWindow is negative", () => {
      expect(() =>
        normalizeCreate({ ...VALID_BASE, contextWindow: -1 }),
      ).toThrow(ModelAdminException);
    });

    it("throws when maxOutputTokens is negative", () => {
      expect(() =>
        normalizeCreate({ ...VALID_BASE, maxOutputTokens: -512 }),
      ).toThrow(ModelAdminException);
    });

    it("deduplicates capabilities", () => {
      const result = normalizeCreate({
        ...VALID_BASE,
        capabilities: ["chat", "chat", "vision"],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).capabilities).toEqual(["chat", "vision"]);
    });

    it("trims capability strings", () => {
      const result = normalizeCreate({
        ...VALID_BASE,
        capabilities: [" chat ", " vision"],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).capabilities).toEqual(["chat", "vision"]);
    });
  });
});

// ── normalizeUpdateModel ──────────────────────────────────────────────────────

describe("normalizeUpdateModel", () => {
  /**
   * `modelCode` is identity. The DATABASE already refuses the write -
   * `98_column_locks.sql` grants atlas_svc INSERT/SELECT on
   * `model.models.model_code` and no UPDATE, verified as atlas_svc: the
   * statement answers `permission denied for table models` while the same
   * statement on `endpoint_url` succeeds.
   *
   * So this guard is not what makes the rename impossible. It is what makes the
   * refusal a 400 instead of an unhandled 500 - the identical defect
   * `PATCH /capability/price-rules/:id` carried from the day the column locks
   * landed until 2026-08-16, and the reason `normalizeUpdateProvider` has the
   * same guard for `providerCode`.
   */
  it("refuses a modelCode change with a 400, not a database error", () => {
    expect(() => normalizeUpdate({ modelCode: "something-else" })).toThrow(
      /modelCode cannot be changed/,
    );
  });

  /**
   * TD-039, measured 2026-08-17 by running each UPDATE as `atlas_svc`:
   *
   *   model.models.model_type          permission denied
   *   model.models.provider            column does not exist
   *
   * Both reached Prisma before this guard - `data: input` goes straight
   * through - so both were 500s on an operator route with nothing in the build
   * able to see them.
   */
  it("refuses modelType - it selects which contract layer serves the row", () => {
    expect(() => normalizeUpdate({ modelType: "embed" })).toThrow(
      /modelType cannot be changed/,
    );
  });

  it("refuses provider - it is derived on read, not a column", () => {
    // `AiModelRecord.provider` is the joined provider's code
    // (`providerRef?.providerCode ?? ""`). `model.models` has no such column,
    // so this field mapped to nothing at all.
    expect(() => normalizeUpdate({ provider: "doubao" })).toThrow(
      /provider cannot be changed/,
    );
  });

  it("refuses it even when it matches the current value", () => {
    // A body that carries the field at all is a caller who believes the route
    // accepts it. Silently ignoring a same-value write teaches them it worked.
    expect(() => normalizeUpdate({ modelCode: "doubao-lite" })).toThrow(
      /modelCode cannot be changed/,
    );
  });

  it("still accepts the fields a repoint needs", () => {
    // Repointing stays ALLOWED on purpose - a supplier changes their base URL,
    // a gateway migration happens, and delete-plus-recreate would drop every
    // grant referencing the model. The signal is `behaviorVersion`, not a lock.
    const result = normalizeUpdate({
      endpointUrl: "https://other.example.com/v1",
      providerId: "p-2",
    });
    expect(result).toMatchObject({
      endpointUrl: "https://other.example.com/v1",
      providerId: "p-2",
    });
  });

  it("returns an empty object for an empty body", () => {
    const result = normalizeUpdate({} satisfies UpdateAiModelBody);
    expect(result).toEqual({});
  });

  // product_251 M-B3: `state` is settable at create and NOT on update - the
  // named actions are the only way to change it, so `AuditMiddleware` records
  // one action per real operation instead of `update` for half of them.
  it("does not accept a state change on the update path", () => {
    const result = normalizeUpdate({
      modelName: "renamed",
    } satisfies UpdateAiModelBody);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).isActive).toBeUndefined();
    expect(result).toMatchObject({ modelName: "renamed" });
  });

  it("throws for an invalid endpointUrl", () => {
    expect(() =>
      normalizeUpdate({
        endpointUrl: "ftp-is-wrong",
      } satisfies UpdateAiModelBody),
    ).toThrow(ModelAdminException);
  });

  it("accepts a valid endpointUrl", () => {
    const result = normalizeUpdate({
      endpointUrl: "https://new.endpoint.com/v2",
    } satisfies UpdateAiModelBody);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).endpointUrl).toBe("https://new.endpoint.com/v2");
  });

  it("throws for a negative contextWindow", () => {
    expect(() =>
      normalizeUpdate({ contextWindow: -1 } satisfies UpdateAiModelBody),
    ).toThrow(ModelAdminException);
  });

  it("accepts contextWindow=0", () => {
    const result = normalizeUpdate({
      contextWindow: 0,
    } satisfies UpdateAiModelBody);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).contextWindow).toBe(0);
  });

  it("passes description null through", () => {
    const result = normalizeUpdate({
      description: null,
    } satisfies UpdateAiModelBody);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).description).toBeNull();
  });

  it("throws when capabilities is empty", () => {
    expect(() =>
      normalizeUpdate({ capabilities: [] } satisfies UpdateAiModelBody),
    ).toThrow(ModelAdminException);
  });

  it("passes supportsStreaming=false through", () => {
    const result = normalizeUpdate({
      supportsStreaming: false,
    } satisfies UpdateAiModelBody);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).supportsStreaming).toBe(false);
  });

  it("passes sort through", () => {
    const result = normalizeUpdate({ sort: 10 } satisfies UpdateAiModelBody);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).sort).toBe(10);
  });

  it("does not include keys absent from the body", () => {
    const result = normalizeUpdate({ sort: 5 } satisfies UpdateAiModelBody);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(Object.keys(result as any)).toEqual(["sort"]);
  });
});

// ── resolved wire ─────────────────────────────────────────────────────────────

/**
 * `resolvedWire` closes the hole next to `behaviorVersion`: the fingerprint said
 * THAT the configuration moved, and the only way to see WHAT it moved to was
 * `POST :id/probe` - a real upstream call that spends tokens. A cheap signal
 * pointing at an expensive answer means the question does not get asked.
 *
 * These pin the LAYERING, not the presence of the field. Order is the part a
 * console-side re-implementation would get wrong, and getting it wrong is
 * silent: you would render a plausible descriptor that no request ever used.
 */
describe("model admin resolvedWire", () => {
  async function firstModel(model: AiModelRecord) {
    const repository = {
      countGrantsByModel: async () => new Map(),
      countEndpointRefsByModelCode: async () => new Map(),
      listModels: async () => [model],
    } as Pick<ModelRegistryRepository, "listModels"> as ModelRegistryRepository;
    const [row] = await new ModelAdminService(repository).listModels(true);
    return row!;
  }

  it("falls back to the protocol defaults when neither layer overrides", async () => {
    const row = await firstModel(makeModel({ providerConfig: null, config: null }));

    expect(row.resolvedWire.schemaVersion).toBe(WIRE_SCHEMA_VERSION);
    expect(row.resolvedWire.authStyle).toBe(OPENAI_WIRE_DEFAULTS.authStyle);
  });

  it("the model's own wire wins over the provider's", async () => {
    const row = await firstModel(
      makeModel({
        providerConfig: { wire: { chatPath: "/provider/chat" } },
        config: { wire: { chatPath: "/model/chat" } },
      }),
    );

    expect(row.resolvedWire.chatPath).toBe("/model/chat");
  });

  it("a provider override survives when the model does not touch that key", async () => {
    const row = await firstModel(
      makeModel({
        providerConfig: { wire: { chatPath: "/provider/chat" } },
        config: { wire: { streamUsage: "native" } },
      }),
    );

    /* The layers merge per key rather than replacing wholesale - which is
       exactly why the console must not do this merge itself. */
    expect(row.resolvedWire.chatPath).toBe("/provider/chat");
    expect(row.resolvedWire.streamUsage).toBe("native");
  });

  it("picks the Anthropic defaults from the model's protocol", async () => {
    const row = await firstModel(
      makeModel({ protocol: "anthropic-messages", providerConfig: null, config: null }),
    );

    expect(row.resolvedWire.headers).toEqual(ANTHROPIC_WIRE_DEFAULTS.headers);
    expect(row.resolvedWire.authStyle).toBe(ANTHROPIC_WIRE_DEFAULTS.authStyle);
  });

  /**
   * `config` and `resolvedWire` are both on the record on purpose: the console
   * shows which layer declared a key (raw) AND what runs (merged). Collapsing
   * them would force the console to merge, and `config` is also where the
   * secret redaction happens - the two serve different questions.
   */
  it("keeps the raw declaration alongside the merged result", async () => {
    const row = await firstModel(
      makeModel({ providerConfig: null, config: { wire: { chatPath: "/x" } } }),
    );

    expect(row.config).toEqual({ wire: { chatPath: "/x" } });
    expect(row.resolvedWire.chatPath).toBe("/x");
  });
});

// ── response safety ───────────────────────────────────────────────────────────

describe("model admin response safety", () => {
  it("redacts secret-like config keys and exposes key reference status", async () => {
    process.env["MODEL_ADMIN_TEST_KEY"] = "secret";

    const repository = {
      countGrantsByModel: async () => new Map(),
      countEndpointRefsByModelCode: async () => new Map(),
      listModels: async () => [
        makeModel({
          config: {
            apiKeyEnvVar: "MODEL_ADMIN_TEST_KEY",
            fallbackModelCodes: ["backup-model"],
            maxTokens: 8192,
            password: "hidden",
            nested: { token: "nested-secret", publicHint: "visible" },
          },
        }),
      ],
    } as Pick<ModelRegistryRepository, "listModels"> as ModelRegistryRepository;
    const service = new ModelAdminService(repository);
    const [model] = await service.listModels(true);

    expect(model?.config).toEqual({
      fallbackModelCodes: ["backup-model"],
      maxTokens: 8192,
      nested: { publicHint: "visible" },
    });
    expect(model?.keyReference).toEqual({
      source: "env",
      name: "MODEL_ADMIN_TEST_KEY",
      configured: true,
    });

    delete process.env["MODEL_ADMIN_TEST_KEY"];
  });
});

// ── grant scope validation ────────────────────────────────────────────────────

describe("normalizeUpdateGrant", () => {
  it("throws when applicationId is updated without applicationType", () => {
    expect(() =>
      normalizeUpdateGrant({
        applicationId: "00000000-0000-4000-a000-000000000001",
      } satisfies UpdateAiModelGrantBody),
    ).toThrow(ModelAdminException);
  });

  it("throws when applicationType is updated without applicationId", () => {
    expect(() =>
      normalizeUpdateGrant({
        applicationType: "agent",
      } satisfies UpdateAiModelGrantBody),
    ).toThrow(ModelAdminException);
  });

  /**
   * INVERTED 2026-08-17. These two used to assert that the update path ACCEPTS
   * and maps application scope. It does not: `98_column_locks.sql` grants
   * `atlas_svc` no UPDATE on `application_id`, `application_type` or
   * `agent_id`, the repository passes `data: input` straight through, and the
   * request came back `permission denied for table model_grants` - a 500.
   *
   * The tests were green the whole time because they call the normalizer with
   * the repository mocked away. That is TD-039 exactly: the two halves meet
   * only at runtime, so a test of either half alone proves nothing about the
   * pair. Verified by running the UPDATE as `atlas_svc` against a real
   * database rather than by reading the DDL.
   */
  it("refuses agentId - the application scope is fixed at create", () => {
    expect(() =>
      normalizeUpdateGrant({ agentId: "00000000-0000-4000-a000-000000000001" }),
    ).toThrow(/agentId cannot be changed/);
  });

  it("refuses applicationId and applicationType for the same reason", () => {
    expect(() =>
      normalizeUpdateGrant({
        applicationId: "00000000-0000-4000-a000-000000000001",
        applicationType: "agent",
      }),
    ).toThrow(/applicationId cannot be changed/);
    expect(() =>
      normalizeUpdateGrant({ applicationType: "agent" }),
    ).toThrow(/applicationType cannot be changed/);
  });

  it("still accepts every field the database does grant", () => {
    // The guard must not overreach: these five ARE in the column-lock list.
    const result = normalizeUpdateGrant({
      taskProfile: "chat-default",
      priority: 5,
      reason: "why",
      expiresAt: null,
    });
    expect(result).toMatchObject({
      taskProfile: "chat-default",
      priority: 5,
      reason: "why",
      expiresAt: null,
    });
  });
});

describe("createGrant", () => {
  it("throws when applicationId is provided without applicationType", async () => {
    const repository = {
      findModelById: async () => makeModel(),
    } as Pick<
      ModelRegistryRepository,
      "findModelById"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    await expect(
      service.createGrant({
        modelId: "00000000-0000-4000-a000-000000000100",
        tenantId: "00000000-0000-4000-a000-000000000200",
        applicationId: "00000000-0000-4000-a000-000000000300",
      } satisfies CreateAiModelGrantBody),
    ).rejects.toThrow(ModelAdminException);
  });
});

// ── P3.2 provider / price / policy contracts ─────────────────────────────────

describe("normalizeCreateProvider", () => {
  it("defaults providerType and strips secret-like config keys", () => {
    const result = normalizeCreateProvider({
      providerCode: "doubao",
      providerName: "Doubao",
      config: {
        publicRegion: "cn-beijing",
        token: "hidden",
        nested: { password: "hidden", timeoutMs: 15000 },
      },
    } satisfies CreateModelProviderBody);

    expect(result).toEqual({
      providerCode: "doubao",
      providerType: "online",
      providerName: "Doubao",
      description: null,
      logoUrl: null,
      homepageUrl: null,
      consoleUrl: null,
      billingUrl: null,
      config: {
        publicRegion: "cn-beijing",
        nested: { timeoutMs: 15000 },
      },
      isActive: true,
    });
  });
});

// ── write-path methods (create/update/activate/deactivate/delete) ─────────────
// These delegate to the repository after normalizing input and (for
// update/activate/delete) asserting the row exists - the normalize* logic
// above was covered, but the delegation itself never was.

function makeProviderRecord(
  overrides: Partial<ModelProviderRecord> = {},
): ModelProviderRecord {
  return {
    id: "00000000-0000-4000-a000-000000000001",
    providerCode: "doubao",
    providerType: "online",
    providerName: "Doubao",
    description: null,
    logoUrl: null,
    homepageUrl: null,
    consoleUrl: null,
    billingUrl: null,
    isActive: true,
    config: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function makeEndpointRecord(
  overrides: Partial<ModelEndpointRecord> = {},
): ModelEndpointRecord {
  return {
    id: "00000000-0000-4000-a000-000000000020",
    code: "chat/default",
    category: "chat",
    primaryModelCode: "gpt-4o",
    fallbackModelCode: null,
    isActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

function makeModelRecord(
  overrides: Partial<AiModelRecord> = {},
): AiModelRecord {
  return {
    id: "00000000-0000-4000-a000-000000000010",
    providerId: "00000000-0000-4000-a000-000000000001",
    modelCode: "gpt-4o",
    modelName: "GPT-4o",
    provider: "openai",
    endpointUrl: "https://api.openai.com/v1",
    protocol: "openai-chat-completions",
    modelType: "chat",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: ["chat"],
    supportsStreaming: true,
    isActive: true,
    sort: 0,
    config: null,
    providerConfig: null,
    providerActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deprecatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

// Untyped against ModelRegistryRepository on purpose - intersecting the mock
// with the real class type makes TS prefer the strict method signatures over
// vi.fn()'s mock-assertion API (mockResolvedValue etc. disappear). Cast only
// at the ModelAdminService construction site below.
// ── lifecycle rules: derived state, delete preconditions, dependent counts ──

describe("endpoint resolution is derived, never cascaded", () => {
  function withModels(models: Array<{ code: string; on: boolean; providerOn: boolean }>) {
    const repo = makeRepositoryMock();
    repo.listModels.mockResolvedValue(
      models.map((m) =>
        makeModel({ modelCode: m.code, isActive: m.on, providerActive: m.providerOn }),
      ),
    );
    return repo;
  }

  it("reports degraded - not disabled - when only the fallback can serve", async () => {
    // The case a cascading write would get wrong: deactivating the primary
    // would switch the endpoint off, killing the failover it was configured
    // for. It is still serving, on the fallback.
    const repo = withModels([
      { code: "primary-model", on: false, providerOn: true },
      { code: "fallback-model", on: true, providerOn: true },
    ]);
    repo.listEndpoints.mockResolvedValue([
      makeEndpointRecord({
        primaryModelCode: "primary-model",
        fallbackModelCode: "fallback-model",
      }),
    ]);

    const [row] = await makeService(repo).listEndpoints();

    expect(row?.resolution).toBe("degraded");
    expect(row?.state).toBe("active");
  });

  it("reports unresolvable when neither model can serve", async () => {
    const repo = withModels([
      { code: "primary-model", on: false, providerOn: true },
      { code: "fallback-model", on: false, providerOn: true },
    ]);
    repo.listEndpoints.mockResolvedValue([
      makeEndpointRecord({
        primaryModelCode: "primary-model",
        fallbackModelCode: "fallback-model",
      }),
    ]);

    expect((await makeService(repo).listEndpoints())[0]?.resolution).toBe(
      "unresolvable",
    );
  });

  it("counts a deactivated PROVIDER as unable to serve", async () => {
    // Deactivating a provider had no effect on anything before this.
    const repo = withModels([
      { code: "primary-model", on: true, providerOn: false },
    ]);
    repo.listEndpoints.mockResolvedValue([
      makeEndpointRecord({
        primaryModelCode: "primary-model",
        fallbackModelCode: null,
      }),
    ]);

    const [row] = await makeService(repo).listEndpoints();
    expect(row?.resolution).toBe("unresolvable");
    expect(row?.models[0]?.availability).toBe("provider_inactive");
  });

  it("keeps the operator's own disable, whatever the models say", async () => {
    // The lost-intent bug a cascade would introduce: an endpoint the operator
    // switched off must not read as healthy just because its models are.
    const repo = withModels([
      { code: "primary-model", on: true, providerOn: true },
    ]);
    repo.listEndpoints.mockResolvedValue([
      makeEndpointRecord({ isActive: false, primaryModelCode: "primary-model" }),
    ]);

    expect((await makeService(repo).listEndpoints())[0]?.resolution).toBe(
      "inactive",
    );
  });
});

describe("delete is available on every resource - soft, and after deactivation", () => {
  it("refuses to delete an active model grant", async () => {
    // The one delete on this plane that had no such precondition, while
    // 10-http-surface.md, 110-management-plane.md and assertDeactivated's own
    // comment all said every delete has one. A grant is what a tenant's
    // traffic authorizes against, so deleting a live one stops that traffic on
    // the next call.
    const repo = makeRepositoryMock();
    repo.findGrantById.mockResolvedValue({ id: "g-1", isActive: true });

    await expect(makeService(repo).deleteGrant("g-1")).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_MUST_DEACTIVATE_FIRST" },
    });
    expect(repo.deleteGrant).not.toHaveBeenCalled();
  });

  it("deletes a deactivated model grant", async () => {
    const repo = makeRepositoryMock();
    repo.findGrantById.mockResolvedValue({ id: "g-1", isActive: false });
    repo.deleteGrant.mockResolvedValue({
      id: "g-1",
      modelId: "m-1",
      tenantId: "2a4271d4-ac9a-4fa6-b479-4f71d8e996e8",
      applicationId: null,
      applicationType: null,
      agentId: null,
      taskProfile: null,
      priority: 100,
      reason: null,
      expiresAt: null,
      isActive: false,
      createdAt: new Date("2026-08-16T00:00:00Z"),
      updatedAt: new Date("2026-08-16T00:00:00Z"),
    });

    await expect(makeService(repo).deleteGrant("g-1")).resolves.toMatchObject({
      id: "g-1",
      state: "inactive",
    });
    expect(repo.deleteGrant).toHaveBeenCalledWith("g-1");
  });

  it("refuses to delete an active price rule", async () => {
    const repo = makeRepositoryMock();
    repo.findPriceRuleById.mockResolvedValue({ id: "pr-1", isActive: true });

    await expect(makeService(repo).deletePriceRule("pr-1")).rejects.toMatchObject(
      { response: { code: "MODEL_ADMIN_MUST_DEACTIVATE_FIRST" } },
    );
    expect(repo.deletePriceRule).not.toHaveBeenCalled();
  });

  it("deletes a deactivated policy", async () => {
    const repo = makeRepositoryMock();
    repo.findPolicyById.mockResolvedValue({ id: "po-1", isActive: false });
    repo.deletePolicy.mockResolvedValue({
      id: "po-1",
      modelId: "m-1",
      tenantId: null,
      rpmLimit: null,
      maxConcurrent: null,
      isActive: false,
      effectiveAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await makeService(repo).deletePolicy("po-1");
    expect(repo.deletePolicy).toHaveBeenCalledWith("po-1");
  });
});

describe("product grant management", () => {
  function build(over: Record<string, unknown> = {}) {
    const repo = {
      findEndpointByCode: vi
        .fn()
        .mockResolvedValue(makeEndpointRecord({ code: "chat/default" })),
      findProductGrantById: vi.fn().mockResolvedValue({
        id: "pg-1",
        productCode: "karda",
        endpointCode: "chat/default",
        applicationId: null,
        applicationType: null,
        isActive: true,
        reason: null,
        expiresAt: null,
        createdAt: new Date("2026-08-13T00:00:00Z"),
        updatedAt: new Date("2026-08-13T00:00:00Z"),
        deletedAt: null,
      }),
      createProductGrant: vi.fn(async (input: Record<string, unknown>) => ({
        id: "pg-new",
        ...input,
        createdAt: new Date("2026-08-13T00:00:00Z"),
        updatedAt: new Date("2026-08-13T00:00:00Z"),
        deletedAt: null,
      })),
      updateProductGrant: vi.fn(),
      deleteProductGrant: vi.fn(),
      ...over,
    };
    return { repo, svc: new ModelAdminService(repo as never) };
  }

  it("grants an endpoint, not a model", async () => {
    const { svc } = build();
    const grant = await svc.createProductGrant({
      productCode: "karda",
      endpointCode: "chat/default",
    });

    expect(grant).toMatchObject({
      productCode: "karda",
      endpointCode: "chat/default",
    });
  });

  it("rejects an endpointCode that names nothing", async () => {
    const { svc } = build({ findEndpointByCode: vi.fn().mockResolvedValue(null) });

    await expect(
      svc.createProductGrant({ productCode: "karda", endpointCode: "nope" }),
    ).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_VALIDATION_FAILED", field: "endpointCode" },
    });
  });

  it("allows granting an endpoint that is not active yet", async () => {
    // Preparing authorization ahead of switching the entry point on is a real
    // sequence, not an error - the same allowance endpoint creation makes for
    // the models it points at.
    const { svc } = build({
      findEndpointByCode: vi
        .fn()
        .mockResolvedValue(makeEndpointRecord({ isActive: false })),
    });

    await expect(
      svc.createProductGrant({ productCode: "karda", endpointCode: "chat/default" }),
    ).resolves.toBeDefined();
  });

  it("refuses to repoint a grant in place", async () => {
    // Repointing is a different authorization decision. Making it a revoke
    // plus a create leaves both in the audit trail; an in-place edit would
    // leave only the destination.
    const { svc } = build();

    await expect(
      svc.updateProductGrant("pg-1", { endpointCode: "chat/pro" }),
    ).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_VALIDATION_FAILED", field: "endpointCode" },
    });
  });

  it("refuses to delete a grant that is still active", async () => {
    const { svc, repo } = build();

    await expect(svc.deleteProductGrant("pg-1")).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_MUST_DEACTIVATE_FIRST" },
    });
    expect(repo.deleteProductGrant).not.toHaveBeenCalled();
  });

  it("404s for an unknown grant", async () => {
    const { svc } = build({ findProductGrantById: vi.fn().mockResolvedValue(null) });

    await expect(svc.deleteProductGrant("nope")).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_PRODUCT_GRANT_NOT_FOUND" },
    });
  });
});

describe("delete preconditions", () => {
  it("refuses to delete a provider that is still active", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(makeProviderRecord({ isActive: true }));

    await expect(makeService(repo).deleteProvider("p-1")).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_MUST_DEACTIVATE_FIRST" },
    });
    expect(repo.deleteProvider).not.toHaveBeenCalled();
  });

  it("refuses to delete a provider that still owns models, and names them", async () => {
    // The old behaviour cascaded: it soft-deleted the models AND every tenant
    // grant on them, silently.
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(makeProviderRecord({ isActive: false }));
    repo.countModelsByProvider.mockResolvedValue(new Map([["p-1", 2]]));
    repo.listModels.mockResolvedValue([
      makeModel({ id: "m-1", modelCode: "alpha" }),
      makeModel({ id: "m-2", modelCode: "beta" }),
    ]);

    await expect(makeService(repo).deleteProvider("p-1")).rejects.toMatchObject({
      response: {
        code: "MODEL_ADMIN_HAS_DEPENDENTS",
        blockedBy: [
          { type: "model", id: "m-1", label: "alpha" },
          { type: "model", id: "m-2", label: "beta" },
        ],
      },
    });
    expect(repo.deleteProvider).not.toHaveBeenCalled();
  });

  it("refuses to delete a model referenced only as a fallback", async () => {
    // A fallback-only reference is the quiet case: removing the model severs
    // a failover chain and nothing else changes.
    const repo = makeRepositoryMock();
    repo.findModelById.mockResolvedValue(
      makeModelRecord({ isActive: false, modelCode: "fallback-model" }),
    );
    repo.countEndpointRefsByModelCode.mockResolvedValue(
      new Map([["fallback-model", 1]]),
    );
    repo.listEndpoints.mockResolvedValue([
      makeEndpointRecord({ id: "e-1", code: "chat/default" }),
    ]);

    await expect(makeService(repo).deleteModel("m-1")).rejects.toMatchObject({
      response: {
        code: "MODEL_ADMIN_HAS_DEPENDENTS",
        blockedBy: [{ type: "endpoint", id: "e-1", label: "chat/default" }],
      },
    });
  });

  it("allows the delete once the resource is deactivated and empty", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(makeProviderRecord({ isActive: false }));
    repo.deleteProvider.mockResolvedValue(
      makeProviderRecord({ isActive: false, deletedAt: new Date() }),
    );

    await makeService(repo).deleteProvider("p-1");
    expect(repo.deleteProvider).toHaveBeenCalledWith("p-1");
  });
});

function makeRepositoryMock() {
  return {
    listProviders: vi.fn(),
    findProviderById: vi.fn(),
    findProviderByCode: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    restoreProvider: vi.fn(),
    deleteProvider: vi.fn(),
    listEndpoints: vi.fn(),
    findEndpointById: vi.fn(),
    findEndpointByCode: vi.fn(),
    createEndpoint: vi.fn(),
    updateEndpoint: vi.fn(),
    restoreEndpoint: vi.fn(),
    deleteEndpoint: vi.fn(),
    findModelByCode: vi.fn(),
    findModelById: vi.fn(),
    createModel: vi.fn(),
    updateModel: vi.fn(),
    deleteModel: vi.fn(),
    listModels: vi.fn().mockResolvedValue([]),
    // Dependent counts default to empty: a test that does not set them is
    // testing something else, and should not be blocked by a phantom
    // dependent it never declared.
    countModelsByProvider: vi.fn().mockResolvedValue(new Map()),
    countGrantsByModel: vi.fn().mockResolvedValue(new Map()),
    countEndpointRefsByModelCode: vi.fn().mockResolvedValue(new Map()),
    findPriceRuleById: vi.fn(),
    deletePriceRule: vi.fn(),
    findPolicyById: vi.fn(),
    deletePolicy: vi.fn(),
    // Absent until 2026-08-16, which is why nothing here ever exercised
    // deleteGrant - and why it kept the one missing deactivation precondition
    // on this plane without a single test noticing.
    findGrantById: vi.fn(),
    deleteGrant: vi.fn(),
  };
}

function makeService(repo: ReturnType<typeof makeRepositoryMock>) {
  return new ModelAdminService(repo as unknown as ModelRegistryRepository);
}

describe("Provider write path", () => {
  const CREATE_BODY: CreateModelProviderBody = {
    providerCode: "doubao",
    providerName: "Doubao",
  };

  it("createProvider normalizes input, writes through the repository, and maps the result", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderByCode.mockResolvedValue(null);
    const created = makeProviderRecord();
    repo.createProvider.mockResolvedValue(created);
    const svc = makeService(repo);

    const result = await svc.createProvider(CREATE_BODY);

    expect(repo.findProviderByCode).toHaveBeenCalledWith("doubao");
    expect(repo.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCode: "doubao",
        providerName: "Doubao",
        providerType: "online",
        isActive: true,
      }),
    );
    expect(repo.restoreProvider).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: created.id, providerCode: "doubao" });
  });

  it("createProvider 409s when the code belongs to a non-deleted provider, without writing", async () => {
    // provider_code carries a plain unique index - a genuine duplicate must
    // surface as a clean conflict, not Prisma's raw P2002.
    const repo = makeRepositoryMock();
    repo.findProviderByCode.mockResolvedValue(
      makeProviderRecord({ deletedAt: null }),
    );
    const svc = makeService(repo);

    await expect(svc.createProvider(CREATE_BODY)).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_PROVIDER_CODE_TAKEN" },
    });
    expect(repo.createProvider).not.toHaveBeenCalled();
    expect(repo.restoreProvider).not.toHaveBeenCalled();
  });

  it("createProvider revives a soft-deleted row under the same code instead of inserting a new one", async () => {
    // provider_code's unique index still holds the soft-deleted row's value
    // (deleteProvider never hard-deletes) - re-creating under that code is a
    // foreseeable operator action (undo a delete), not a real duplicate.
    const repo = makeRepositoryMock();
    const softDeleted = makeProviderRecord({
      deletedAt: new Date("2026-02-01T00:00:00Z"),
      isActive: false,
    });
    repo.findProviderByCode.mockResolvedValue(softDeleted);
    repo.restoreProvider.mockResolvedValue(
      makeProviderRecord({ deletedAt: null, isActive: true }),
    );
    const svc = makeService(repo);

    const result = await svc.createProvider(CREATE_BODY);

    expect(repo.restoreProvider).toHaveBeenCalledWith(
      softDeleted.id,
      expect.objectContaining({ providerName: "Doubao" }),
    );
    expect(repo.createProvider).not.toHaveBeenCalled();
    expect(result.state).toBe("active");
  });

  it("createProvider excludes providerCode/providerType from the revive payload", async () => {
    // atlas_svc has no UPDATE grant on either column (db-init column lock) -
    // spreading the full create input into restoreProvider's update 500s at
    // the DB layer (found live, same investigation as the P2002 fix above).
    const repo = makeRepositoryMock();
    const softDeleted = makeProviderRecord({
      deletedAt: new Date("2026-02-01T00:00:00Z"),
    });
    repo.findProviderByCode.mockResolvedValue(softDeleted);
    repo.restoreProvider.mockResolvedValue(makeProviderRecord());
    const svc = makeService(repo);

    await svc.createProvider(CREATE_BODY);

    const revivePayload = repo.restoreProvider.mock.calls[0]?.[1];
    expect(revivePayload).not.toHaveProperty("providerCode");
    expect(revivePayload).not.toHaveProperty("providerType");
  });

  it("updateProvider rejects a providerCode change with a clean 400, without writing", async () => {
    // Immutable after creation (db-init column lock: atlas_svc has no UPDATE
    // grant on provider_code) - must reject before it ever reaches Prisma.
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(makeProviderRecord());
    const svc = makeService(repo);

    await expect(
      svc.updateProvider("00000000-0000-4000-a000-000000000001", {
        providerCode: "renamed",
      }),
    ).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_VALIDATION_FAILED", field: "providerCode" },
    });
    expect(repo.updateProvider).not.toHaveBeenCalled();
  });

  it("updateProvider rejects a providerType change with a clean 400, without writing", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(makeProviderRecord());
    const svc = makeService(repo);

    await expect(
      svc.updateProvider("00000000-0000-4000-a000-000000000001", {
        providerType: "private",
      }),
    ).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_VALIDATION_FAILED", field: "providerType" },
    });
    expect(repo.updateProvider).not.toHaveBeenCalled();
  });

  it("updateProvider 404s when the provider does not exist, without writing", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(null);
    const svc = makeService(repo);

    const body: UpdateModelProviderBody = { providerName: "Renamed" };
    await expect(svc.updateProvider("missing-id", body)).rejects.toThrow(
      ModelAdminException,
    );
    expect(repo.updateProvider).not.toHaveBeenCalled();
  });

  it("updateProvider writes only the normalized changed fields", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(makeProviderRecord());
    repo.updateProvider.mockResolvedValue(
      makeProviderRecord({ providerName: "Renamed" }),
    );
    const svc = makeService(repo);

    const result = await svc.updateProvider("00000000-0000-4000-a000-000000000001", {
      providerName: "Renamed",
    });

    expect(repo.updateProvider).toHaveBeenCalledWith(
      "00000000-0000-4000-a000-000000000001",
      { providerName: "Renamed" },
    );
    expect(result.providerName).toBe("Renamed");
  });

  it("setProviderActive(true) 404s when the provider does not exist", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(null);
    const svc = makeService(repo);

    await expect(
      svc.setProviderActive("missing-id", true),
    ).rejects.toThrow(ModelAdminException);
    expect(repo.updateProvider).not.toHaveBeenCalled();
  });

  it("setProviderActive(false) deactivates via updateProvider({ isActive: false })", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(makeProviderRecord());
    repo.updateProvider.mockResolvedValue(
      makeProviderRecord({ isActive: false }),
    );
    const svc = makeService(repo);

    const result = await svc.setProviderActive(
      "00000000-0000-4000-a000-000000000001",
      false,
    );

    expect(repo.updateProvider).toHaveBeenCalledWith(
      "00000000-0000-4000-a000-000000000001",
      { isActive: false },
    );
    expect(result.state).toBe("inactive");
  });

  it("deleteProvider 404s when the provider does not exist, without deleting", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(null);
    const svc = makeService(repo);

    await expect(svc.deleteProvider("missing-id")).rejects.toThrow(
      ModelAdminException,
    );
    expect(repo.deleteProvider).not.toHaveBeenCalled();
  });

  it("deleteProvider deletes an existing provider and returns the mapped (soft-deleted) row", async () => {
    const repo = makeRepositoryMock();
    repo.findProviderById.mockResolvedValue(
      makeProviderRecord({ isActive: false }),
    );
    repo.deleteProvider.mockResolvedValue(
      makeProviderRecord({ isActive: false, deletedAt: new Date("2026-02-01T00:00:00Z") }),
    );
    const svc = makeService(repo);

    const result = await svc.deleteProvider(
      "00000000-0000-4000-a000-000000000001",
    );

    expect(repo.deleteProvider).toHaveBeenCalledWith(
      "00000000-0000-4000-a000-000000000001",
    );
    expect(result.state).toBe("inactive");
  });
});

describe("Endpoint write path (TD-028, vxture-atlas#143)", () => {
  const CREATE_BODY: CreateModelEndpointBody = {
    code: "chat/default",
    primaryModelCode: "gpt-4o",
  };

  it("createEndpoint validates primaryModelCode against the registry, writes through the repository, and maps the result", async () => {
    const repo = makeRepositoryMock();
    repo.findModelByCode.mockResolvedValue(makeModelRecord());
    repo.findEndpointByCode.mockResolvedValue(null);
    const created = makeEndpointRecord();
    repo.createEndpoint.mockResolvedValue(created);
    const svc = makeService(repo);

    const result = await svc.createEndpoint(CREATE_BODY);

    expect(repo.findModelByCode).toHaveBeenCalledWith("gpt-4o");
    expect(repo.createEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "chat/default",
        category: "chat",
        primaryModelCode: "gpt-4o",
        fallbackModelCode: null,
        isActive: true,
      }),
    );
    expect(result).toMatchObject({ id: created.id, code: "chat/default" });
  });

  it("createEndpoint rejects a primaryModelCode that matches no model, without writing", async () => {
    const repo = makeRepositoryMock();
    repo.findModelByCode.mockResolvedValue(null);
    const svc = makeService(repo);

    await expect(svc.createEndpoint(CREATE_BODY)).rejects.toMatchObject({
      response: {
        code: "MODEL_ADMIN_VALIDATION_FAILED",
        field: "primaryModelCode",
      },
    });
    expect(repo.createEndpoint).not.toHaveBeenCalled();
  });

  it("createEndpoint validates fallbackModelCode too, when given", async () => {
    const repo = makeRepositoryMock();
    repo.findModelByCode.mockImplementation((code: string) =>
      Promise.resolve(code === "gpt-4o" ? makeModelRecord() : null),
    );
    const svc = makeService(repo);

    await expect(
      svc.createEndpoint({ ...CREATE_BODY, fallbackModelCode: "ghost-model" }),
    ).rejects.toMatchObject({
      response: {
        code: "MODEL_ADMIN_VALIDATION_FAILED",
        field: "fallbackModelCode",
      },
    });
    expect(repo.createEndpoint).not.toHaveBeenCalled();
  });

  it("createEndpoint 409s when the code belongs to a non-deleted endpoint, without writing", async () => {
    const repo = makeRepositoryMock();
    repo.findModelByCode.mockResolvedValue(makeModelRecord());
    repo.findEndpointByCode.mockResolvedValue(
      makeEndpointRecord({ deletedAt: null }),
    );
    const svc = makeService(repo);

    await expect(svc.createEndpoint(CREATE_BODY)).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_ENDPOINT_CODE_TAKEN" },
    });
    expect(repo.createEndpoint).not.toHaveBeenCalled();
    expect(repo.restoreEndpoint).not.toHaveBeenCalled();
  });

  it("createEndpoint revives a soft-deleted row under the same code instead of inserting a new one", async () => {
    const repo = makeRepositoryMock();
    repo.findModelByCode.mockResolvedValue(makeModelRecord());
    const softDeleted = makeEndpointRecord({
      id: "00000000-0000-4000-a000-000000000099",
      deletedAt: new Date("2026-02-01T00:00:00Z"),
    });
    repo.findEndpointByCode.mockResolvedValue(softDeleted);
    repo.restoreEndpoint.mockResolvedValue(
      makeEndpointRecord({ id: softDeleted.id, deletedAt: null }),
    );
    const svc = makeService(repo);

    const result = await svc.createEndpoint(CREATE_BODY);

    expect(repo.restoreEndpoint).toHaveBeenCalledWith(
      softDeleted.id,
      expect.not.objectContaining({ code: expect.anything() }),
    );
    expect(repo.createEndpoint).not.toHaveBeenCalled();
    expect(result.id).toBe(softDeleted.id);
  });

  it("updateEndpoint 404s when the endpoint does not exist, without writing", async () => {
    const repo = makeRepositoryMock();
    repo.findEndpointById.mockResolvedValue(null);
    const svc = makeService(repo);

    await expect(
      svc.updateEndpoint("missing-id", { category: "embedding" }),
    ).rejects.toThrow(ModelAdminException);
    expect(repo.updateEndpoint).not.toHaveBeenCalled();
  });

  it("updateEndpoint validates a changed primaryModelCode before writing", async () => {
    const repo = makeRepositoryMock();
    repo.findEndpointById.mockResolvedValue(makeEndpointRecord());
    repo.findModelByCode.mockResolvedValue(null);
    const svc = makeService(repo);

    await expect(
      svc.updateEndpoint(makeEndpointRecord().id, {
        primaryModelCode: "ghost-model",
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MODEL_ADMIN_VALIDATION_FAILED",
        field: "primaryModelCode",
      },
    });
    expect(repo.updateEndpoint).not.toHaveBeenCalled();
  });

  it("updateEndpoint writes only the normalized changed fields", async () => {
    const repo = makeRepositoryMock();
    const existing = makeEndpointRecord();
    repo.findEndpointById.mockResolvedValue(existing);
    repo.updateEndpoint.mockResolvedValue(
      makeEndpointRecord({ category: "embedding" }),
    );
    const svc = makeService(repo);

    const result = await svc.updateEndpoint(existing.id, {
      category: "embedding",
    });

    expect(repo.updateEndpoint).toHaveBeenCalledWith(existing.id, {
      category: "embedding",
    });
    expect(repo.findModelByCode).not.toHaveBeenCalled();
    expect(result.category).toBe("embedding");
  });

  it("setEndpointActive(false) deactivates via updateEndpoint({ isActive: false })", async () => {
    const repo = makeRepositoryMock();
    repo.findEndpointById.mockResolvedValue(makeEndpointRecord());
    repo.updateEndpoint.mockResolvedValue(
      makeEndpointRecord({ isActive: false }),
    );
    const svc = makeService(repo);

    const result = await svc.setEndpointActive(
      "00000000-0000-4000-a000-000000000020",
      false,
    );

    expect(repo.updateEndpoint).toHaveBeenCalledWith(
      "00000000-0000-4000-a000-000000000020",
      { isActive: false },
    );
    expect(result.state).toBe("inactive");
  });

  it("deleteEndpoint deletes an existing endpoint and returns the mapped (soft-deleted) row", async () => {
    const repo = makeRepositoryMock();
    repo.findEndpointById.mockResolvedValue(
      makeEndpointRecord({ isActive: false }),
    );
    repo.deleteEndpoint.mockResolvedValue(
      makeEndpointRecord({
        isActive: false,
        deletedAt: new Date("2026-02-01T00:00:00Z"),
      }),
    );
    const svc = makeService(repo);

    const result = await svc.deleteEndpoint(
      "00000000-0000-4000-a000-000000000020",
    );

    expect(repo.deleteEndpoint).toHaveBeenCalledWith(
      "00000000-0000-4000-a000-000000000020",
    );
    expect(result.state).toBe("inactive");
  });

  it("listEndpoints maps every repository row", async () => {
    const repo = makeRepositoryMock();
    repo.listEndpoints.mockResolvedValue([
      makeEndpointRecord(),
      makeEndpointRecord({
        id: "00000000-0000-4000-a000-000000000021",
        code: "embed/default",
      }),
    ]);
    const svc = makeService(repo);

    const result = await svc.listEndpoints();

    expect(repo.listEndpoints).toHaveBeenCalledWith(true, {});
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.code)).toEqual([
      "chat/default",
      "embed/default",
    ]);
  });
});

// ── provider health / gateway performance ─────────────────────────────────────
// `metricsRegistry` is a process-wide singleton (see metrics.registry.ts), so
// each case below uses its own provider code to stay isolated from the
// others despite sharing that singleton across the file.

describe("Provider health (listProviders)", () => {
  it("attaches health derived from real provider traffic", async () => {
    const repo = makeRepositoryMock();
    const provider = makeProviderRecord({ providerCode: "td030-healthy" });
    repo.listProviders.mockResolvedValue([provider]);
    const svc = makeService(repo);

    metricsRegistry.incCounter("model_requests_total", {
      operation: "chat",
      status: "started",
      provider: "td030-healthy",
    });
    metricsRegistry.incCounter("model_requests_total", {
      operation: "chat",
      status: "success",
      provider: "td030-healthy",
    });
    metricsRegistry.observeHistogram("model_request_latency_ms", 120, {
      operation: "chat",
      provider: "td030-healthy",
    });

    const [result] = await svc.listProviders();

    expect(result!.health).toMatchObject({
      status: "healthy",
      successRate: 1,
      avgLatencyMs: 120,
      attempts: 1,
    });
    expect(result!.health.lastObservedAt).not.toBeNull();
  });

  it("reports status unknown when the provider has no observed traffic yet", async () => {
    const repo = makeRepositoryMock();
    const provider = makeProviderRecord({ providerCode: "td030-silent" });
    repo.listProviders.mockResolvedValue([provider]);
    const svc = makeService(repo);

    const [result] = await svc.listProviders();

    expect(result!.health).toEqual({
      status: "unknown",
      successRate: null,
      avgLatencyMs: null,
      attempts: 0,
      lastObservedAt: null,
    });
  });

  it("classifies degraded vs. down by success-rate threshold", async () => {
    const repo = makeRepositoryMock();
    repo.listProviders.mockResolvedValue([
      makeProviderRecord({
        id: "00000000-0000-4000-a000-000000009001",
        providerCode: "td030-degraded",
      }),
      makeProviderRecord({
        id: "00000000-0000-4000-a000-000000009002",
        providerCode: "td030-down",
      }),
    ]);
    const svc = makeService(repo);

    // 90% success -> degraded (below the 98% healthy bar)
    for (let i = 0; i < 10; i++) {
      metricsRegistry.incCounter("model_requests_total", {
        operation: "chat",
        status: "started",
        provider: "td030-degraded",
      });
    }
    for (let i = 0; i < 9; i++) {
      metricsRegistry.incCounter("model_requests_total", {
        operation: "chat",
        status: "success",
        provider: "td030-degraded",
      });
    }

    // 50% success -> down (below the 80% degraded floor)
    for (let i = 0; i < 10; i++) {
      metricsRegistry.incCounter("model_requests_total", {
        operation: "chat",
        status: "started",
        provider: "td030-down",
      });
    }
    for (let i = 0; i < 5; i++) {
      metricsRegistry.incCounter("model_requests_total", {
        operation: "chat",
        status: "success",
        provider: "td030-down",
      });
    }

    const [degraded, down] = await svc.listProviders();

    expect(degraded!.health.status).toBe("degraded");
    expect(down!.health.status).toBe("down");
  });
});

describe("getGatewayPerformance", () => {
  it("reports cumulative per-provider traffic alongside process metadata", async () => {
    const repo = makeRepositoryMock();
    const svc = makeService(repo);

    metricsRegistry.incCounter("model_requests_total", {
      operation: "chat",
      status: "started",
      provider: "td030-perf",
    });
    metricsRegistry.incCounter("model_requests_total", {
      operation: "chat",
      status: "success",
      provider: "td030-perf",
    });
    metricsRegistry.observeHistogram("model_request_latency_ms", 50, {
      operation: "chat",
      provider: "td030-perf",
    });
    metricsRegistry.changeGauge("model_request_in_flight", 2, {
      operation: "chat",
    });

    try {
      const result = await svc.getGatewayPerformance();

      expect(result.generatedAt).toEqual(expect.any(String));
      expect(result.processStartedAt).toEqual(expect.any(String));
      expect(result.inFlightRequests).toBeGreaterThanOrEqual(2);
      expect(result.providers).toContainEqual(
        expect.objectContaining({
          provider: "td030-perf",
          attempts: 1,
          successes: 1,
          errors: 0,
          errorRate: 0,
          avgLatencyMs: 50,
        }),
      );
    } finally {
      // undo the gauge change - it is process-global and would otherwise
      // leak a phantom in-flight request into later tests in this file.
      metricsRegistry.changeGauge("model_request_in_flight", -2, {
        operation: "chat",
      });
    }
  });
});

describe("Model write path", () => {
  it("createModel normalizes input, writes through the repository, and maps the result", async () => {
    const repo = makeRepositoryMock();
    repo.createModel.mockResolvedValue(makeModelRecord());
    const svc = makeService(repo);

    const result = await svc.createModel(VALID_BASE);

    expect(repo.createModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelCode: "gpt-4o",
        protocol: "openai-chat-completions",
      }),
    );
    expect(result).toMatchObject({ id: makeModelRecord().id, modelCode: "gpt-4o" });
  });

  it("updateModel 404s when the model does not exist, without writing", async () => {
    const repo = makeRepositoryMock();
    repo.findModelById.mockResolvedValue(null);
    const svc = makeService(repo);

    const body: UpdateAiModelBody = { modelName: "Renamed" };
    await expect(svc.updateModel("missing-id", body)).rejects.toThrow(
      ModelAdminException,
    );
    expect(repo.updateModel).not.toHaveBeenCalled();
  });

  it("setModelActive(false) deactivates an existing model", async () => {
    const repo = makeRepositoryMock();
    repo.findModelById.mockResolvedValue(makeModelRecord());
    repo.updateModel.mockResolvedValue(makeModelRecord({ isActive: false }));
    const svc = makeService(repo);

    const result = await svc.setModelActive(
      "00000000-0000-4000-a000-000000000010",
      false,
    );

    expect(repo.updateModel).toHaveBeenCalledWith(
      "00000000-0000-4000-a000-000000000010",
      { isActive: false },
    );
    expect(result.state).toBe("inactive");
  });

  it("setModelActive(true) 404s when the model does not exist", async () => {
    const repo = makeRepositoryMock();
    repo.findModelById.mockResolvedValue(null);
    const svc = makeService(repo);

    await expect(svc.setModelActive("missing-id", true)).rejects.toThrow(
      ModelAdminException,
    );
    expect(repo.updateModel).not.toHaveBeenCalled();
  });

  it("deleteModel 404s when the model does not exist, without deleting", async () => {
    const repo = makeRepositoryMock();
    repo.findModelById.mockResolvedValue(null);
    const svc = makeService(repo);

    await expect(svc.deleteModel("missing-id")).rejects.toThrow(
      ModelAdminException,
    );
    expect(repo.deleteModel).not.toHaveBeenCalled();
  });

  it("deleteModel deletes an existing model and returns the mapped (soft-deleted) row", async () => {
    const repo = makeRepositoryMock();
    repo.findModelById.mockResolvedValue(makeModelRecord({ isActive: false }));
    repo.deleteModel.mockResolvedValue(
      makeModelRecord({ isActive: false, deletedAt: new Date("2026-02-01T00:00:00Z") }),
    );
    const svc = makeService(repo);

    const result = await svc.deleteModel(
      "00000000-0000-4000-a000-000000000010",
    );

    expect(repo.deleteModel).toHaveBeenCalledWith(
      "00000000-0000-4000-a000-000000000010",
    );
    expect(result.state).toBe("inactive");
  });
});

describe("normalizeCreatePriceRule", () => {
  it("normalizes provider cost metadata", async () => {
    const repository = {
      findModelById: async () => makeModel(),
    } as Pick<
      ModelRegistryRepository,
      "findModelById"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const result =
      await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).normalizeCreatePriceRule({
        modelId: "00000000-0000-4000-a000-000000000100",
        inputUnitPrice: 0.1,
        outputUnitPrice: "0.2",
        requestUnitPrice: null,
      } satisfies CreateModelPriceRuleBody);

    expect(result).toMatchObject({
      modelId: "00000000-0000-4000-a000-000000000100",
      billingMode: "token",
      currency: "CNY",
      unitTokens: 1000000,
      inputUnitPrice: "0.1",
      outputUnitPrice: "0.2",
      requestUnitPrice: "0",
      isActive: true,
    });
    expect(result.effectiveAt).toBeInstanceOf(Date);
  });

  it("throws for negative price", async () => {
    const repository = {
      findModelById: async () => makeModel(),
    } as Pick<
      ModelRegistryRepository,
      "findModelById"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).normalizeCreatePriceRule({
        modelId: "00000000-0000-4000-a000-000000000100",
        inputUnitPrice: "-1",
      } satisfies CreateModelPriceRuleBody),
    ).rejects.toThrow(ModelAdminException);
  });
});

describe("normalizeCreatePolicy", () => {
  it("normalizes bigint limits and default priority", async () => {
    const repository = {
      findModelById: async () => makeModel(),
    } as Pick<
      ModelRegistryRepository,
      "findModelById"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const result =
      await // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).normalizeCreatePolicy({
        modelId: "00000000-0000-4000-a000-000000000100",
        tenantId: "00000000-0000-4000-a000-000000000200",
        rateLimitTpm: "100000",
        rateLimitTpd: 200000,
      } satisfies CreateModelPolicyBody);

    expect(result).toMatchObject({
      modelId: "00000000-0000-4000-a000-000000000100",
      tenantId: "00000000-0000-4000-a000-000000000200",
      priority: 100,
      rateLimitTpm: 100000n,
      rateLimitTpd: 200000n,
      isActive: true,
    });
  });

  it("throws for negative bigint limit", async () => {
    const repository = {
      findModelById: async () => makeModel(),
    } as Pick<
      ModelRegistryRepository,
      "findModelById"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).normalizeCreatePolicy({
        modelId: "00000000-0000-4000-a000-000000000100",
        rateLimitTpm: "-1",
      } satisfies CreateModelPolicyBody),
    ).rejects.toThrow(ModelAdminException);
  });
});

// ── P3.3 quota / usage read contracts ────────────────────────────────────────

describe("price-rule effective-at reads (append-versioning is queryable)", () => {
  function makeRepo() {
    return {
      listPriceRules: vi.fn().mockResolvedValue([]),
    } as unknown as ModelRegistryRepository;
  }

  it("passes no time filter through when asOf is omitted - the full ledger", async () => {
    const repo = makeRepo();
    await new ModelAdminService(repo).listPriceRules({});

    const args = (repo.listPriceRules as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(args).not.toHaveProperty("asOf");
  });

  it("passes asOf through as a Date so the repository can bound the window", async () => {
    const repo = makeRepo();
    await new ModelAdminService(repo).listPriceRules({
      asOf: "2026-06-15T00:00:00.000Z",
    });

    const args = (repo.listPriceRules as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { asOf: Date };
    expect(args.asOf.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it('accepts "now" so a caller need not clock-sync', async () => {
    const repo = makeRepo();
    const before = Date.now();
    await new ModelAdminService(repo).listPriceRules({ asOf: "now" });

    const args = (repo.listPriceRules as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { asOf: Date };
    expect(args.asOf.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("rejects an unparseable asOf rather than silently reading everything", async () => {
    // Silently ignoring a bad timestamp would answer "what was in force" with
    // the whole ledger - the wrong answer, delivered confidently.
    await expect(
      new ModelAdminService(makeRepo()).listPriceRules({ asOf: "last-tuesday" }),
    ).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_VALIDATION_FAILED", field: "asOf" },
    });
  });
});

describe("grant activate/deactivate symmetry", () => {
  it("deactivates via setGrantActive(false)", async () => {
    const updateGrant = vi.fn().mockResolvedValue({
      id: "g1",
      modelId: "m1",
      tenantId: "t1",
      applicationId: null,
      applicationType: null,
      agentId: null,
      taskProfile: null,
      priority: 100,
      reason: null,
      expiresAt: null,
      isActive: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const repo = {
      ...makeRepositoryMock(),
      findGrantById: vi.fn().mockResolvedValue({ id: "g1" }),
      updateGrant,
    } as unknown as ModelRegistryRepository;
    const svc = new ModelAdminService(repo);

    const result = await svc.setGrantActive("g1", false);

    expect(updateGrant).toHaveBeenCalledWith("g1", { isActive: false });
    expect(result.state).toBe("inactive");
  });
});

describe("quota and usage read contracts", () => {
  it("reports bulk quota listing as not implemented (TD-002/TD-005)", () => {
    // The platform exposes only a single-workspace C2 read, no bulk/list
    // endpoint - returning [] here would read as "no tenant has a quota",
    // which is false, so this is an explicit 501 instead.
    const service = new ModelAdminService({} as ModelRegistryRepository);

    expect(() =>
      service.listTenantQuotas({
        tenantId: "00000000-0000-4000-a000-000000000200",
      }),
    ).toThrow(ModelAdminException);
  });

  it("maps usage summary bigint fields to strings", async () => {
    const repository = {
      listUsageSummaries: async () => [makeUsageSummary()],
    } as Pick<
      ModelRegistryRepository,
      "listUsageSummaries"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const { items: [summary] } = await service.listUsageSummaries({
      tenantId: "00000000-0000-4000-a000-000000000200",
      applicationId: "00000000-0000-4000-a000-000000000300",
      applicationType: "agent",
    });

    expect(summary).toMatchObject({
      requests: "1",
      inputTokens: "4",
      outputTokens: "6",
      totalTokens: "10",
      errors: "0",
    });
  });

  it("carries productCode through to the response, not just into the GROUP BY", async () => {
    // The rollup groups by product, so the response has to say WHICH product.
    // This was briefly wrong in the other direction and that state was worse
    // than not grouping at all: rows split one level finer while the value
    // explaining the split was discarded, so the same tenant and workspace
    // appeared repeatedly with nothing to tell the rows apart.
    //
    // The SQL-level test cannot catch this - it asserts the query, and the
    // query was already right. This asserts the last hop.
    const repository = {
      listUsageSummaries: async () => [makeUsageSummary({ productCode: "karda" })],
    } as Pick<
      ModelRegistryRepository,
      "listUsageSummaries"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const { items: [summary] } = await service.listUsageSummaries({});

    expect(summary?.productCode).toBe("karda");
  });

  it("leaves productCode null when the row has none, rather than inventing one", async () => {
    // Probe calls have no calling product by definition, and rows written
    // before product_code existed have none either. Both must stay null - a
    // placeholder would put Atlas's own diagnostic traffic under a product's
    // name.
    const repository = {
      listUsageSummaries: async () => [makeUsageSummary({ productCode: null })],
    } as Pick<
      ModelRegistryRepository,
      "listUsageSummaries"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const { items: [summary] } = await service.listUsageSummaries({});

    expect(summary?.productCode).toBeNull();
  });

  it("rejects a cycleMonth that isn't YYYY-MM", async () => {
    const repository = {} as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    await expect(
      service.listUsageSummaries({ cycleMonth: "202606" }),
    ).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_VALIDATION_FAILED", field: "cycleMonth" },
    });
  });

  it("rejects usage applicationId without applicationType", async () => {
    const repository = {
      listUsageSummaries: async () => [],
    } as Pick<
      ModelRegistryRepository,
      "listUsageSummaries"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    await expect(
      service.listUsageSummaries({
        applicationId: "00000000-0000-4000-a000-000000000300",
      }),
    ).rejects.toThrow(ModelAdminException);
  });

  // ── provider/model rollup axes ────────────────────────────────────────────

  it("defaults to the tenant axis, keeping the pre-#159 row shape", async () => {
    const repository = {
      listUsageSummaries: async () => [makeUsageSummary()],
      listUsageRollup: async () => {
        throw new Error("tenant axis must not touch the rollup query");
      },
    } as Pick<
      ModelRegistryRepository,
      "listUsageSummaries" | "listUsageRollup"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const { dimension, items: [summary] } = await service.listUsageSummaries({});

    /* 轴在信封上，不在行上（A-4）——空结果时行会消失，而轴是服务端解析出来的，
       必须留在一个空结果也带得走的位置。 */
    expect(dimension).toBe("tenant");
    expect(summary).toMatchObject({
      tenantId: "00000000-0000-4000-a000-000000000200",
      applicationType: "agent",
      // The rollup-only identity fields are present but empty on this axis.
      providerCode: null,
      modelCode: null,
    });
  });

  it("puts the group key in the field its dimension names, nulling the rest", async () => {
    const repository = {
      listUsageRollup: async (params: { dimension: string }) => [
        {
          groupKey: params.dimension === "provider" ? "doubao" : "doubao-pro",
          cycleMonth: "2026-08",
          requests: 3n,
          inputTokens: 10n,
          outputTokens: 20n,
          totalTokens: 30n,
          errors: 1n,
        },
      ],
    } as unknown as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const providerPage = await service.listUsageSummaries({
      groupBy: "provider",
    });
    const modelPage = await service.listUsageSummaries({ groupBy: "model" });
    const [byProvider] = providerPage.items;
    const [byModel] = modelPage.items;

    expect(providerPage.dimension).toBe("provider");
    expect(modelPage.dimension).toBe("model");
    expect(byProvider).toMatchObject({
      providerCode: "doubao",
      modelCode: null,
      totalTokens: "30",
    });
    expect(byModel).toMatchObject({
      modelCode: "doubao-pro",
      providerCode: null,
    });
    // A rollup sums across every tenant - reporting one would misstate what
    // was counted.
    expect(byProvider?.tenantId).toBeNull();
    expect(byProvider?.applicationId).toBeNull();
  });

  it("serves the endpoint axis now that reqlog carries endpoint_code", async () => {
    const repository = {
      listUsageRollup: async () => [
        {
          groupKey: "chat/default",
          cycleMonth: "2026-08",
          requests: 7n,
          inputTokens: 100n,
          outputTokens: 200n,
          totalTokens: 300n,
          errors: 0n,
        },
      ],
    } as unknown as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const { dimension, items: [row] } = await service.listUsageSummaries({
      groupBy: "endpoint",
    });

    expect(dimension).toBe("endpoint");
    expect(row).toMatchObject({
      endpointCode: "chat/default",
      modelCode: null,
      providerCode: null,
      totalTokens: "300",
    });
  });

  it("serves the product axis - what a product costs to run", async () => {
    const repository = {
      listUsageRollup: async () => [
        {
          groupKey: "karda",
          cycleMonth: "2026-08",
          requests: 278n,
          inputTokens: 100n,
          outputTokens: 200n,
          totalTokens: 250201n,
          errors: 3n,
        },
      ],
    } as unknown as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const { dimension, items: [row] } = await service.listUsageSummaries({
      groupBy: "product",
    });

    expect(dimension).toBe("product");
    expect(row).toMatchObject({
      productCode: "karda",
      tenantId: null,
      workspaceId: null,
      totalTokens: "250201",
    });
  });

  it("carries workspaceId on the tenant axis - the subject is the pair", async () => {
    // Grouping by tenant alone hides which workspace burned it; by workspace
    // alone loses which customer to bill. Both must be on the row.
    const repository = {
      listUsageSummaries: async () => [makeUsageSummary()],
    } as Pick<
      ModelRegistryRepository,
      "listUsageSummaries"
    > as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    const { dimension, items: [row] } = await service.listUsageSummaries({});

    expect(dimension).toBe("tenant");
    expect(row).toMatchObject({
      tenantId: "00000000-0000-4000-a000-000000000200",
      workspaceId: "00000000-0000-4000-a000-000000000201",
    });
  });

  it("rejects an unknown groupBy value", async () => {
    const repository = {} as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    await expect(
      service.listUsageSummaries({ groupBy: "workspace" }),
    ).rejects.toMatchObject({
      response: { code: "MODEL_ADMIN_VALIDATION_FAILED", field: "groupBy" },
    });
  });

  it("passes providerCode/modelCode filters through on either axis", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const repository = {
      listUsageSummaries: async (f: Record<string, unknown>) => {
        seen.push(f);
        return [];
      },
      listUsageRollup: async (f: Record<string, unknown>) => {
        seen.push(f);
        return [];
      },
    } as unknown as ModelRegistryRepository;
    const service = new ModelAdminService(repository);

    await service.listUsageSummaries({ providerCode: "doubao" });
    await service.listUsageSummaries({ modelCode: "gpt-4o", groupBy: "model" });

    expect(seen[0]).toMatchObject({ providerCode: "doubao" });
    expect(seen[1]).toMatchObject({ modelCode: "gpt-4o", dimension: "model" });
  });
});

function makeModel(overrides: Partial<AiModelRecord> = {}): AiModelRecord {
  return {
    id: "00000000-0000-4000-a000-000000000100",
    providerId: null,
    modelCode: "test-model",
    modelName: "Test Model",
    provider: "private",
    endpointUrl: "https://model.example.test",
    protocol: "openai",
    modelType: "chat",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: ["chat"],
    supportsStreaming: true,
    isActive: true,
    sort: 100,
    config: null,
    providerConfig: null,
    providerActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date("2026-06-06T00:00:00.000Z"),
    updatedAt: new Date("2026-06-06T00:00:00.000Z"),
    deprecatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}



function makeUsageSummary(
  overrides: Partial<TenantUsageSummaryRecord> = {},
): TenantUsageSummaryRecord {
  return {
    tenantId: "00000000-0000-4000-a000-000000000200",
    workspaceId: "00000000-0000-4000-a000-000000000201",
    productCode: "karda",
    applicationId: "00000000-0000-4000-a000-000000000300",
    applicationType: "agent",
    cycleMonth: "2026-06",
    requests: 1n,
    inputTokens: 4n,
    outputTokens: 6n,
    totalTokens: 10n,
    errors: 0n,
    ...overrides,
  };
}

/**
 * Verified against postgres:18 with the full DDL sequence applied (2026-08-16):
 * as `atlas_svc`, `UPDATE model.model_price_rules SET input_unit_price = ...`
 * answers `permission denied for table model_price_rules`. The route accepted
 * that field and every other value field, so an operator editing a price got a
 * 500 - and nothing here covered it, which is why it survived.
 */
describe("normalizeUpdatePriceRule - append-versioned, not editable", () => {
  const update = (body: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).normalizeUpdatePriceRule(body);

  it.each([
    "billingMode",
    "currency",
    "unitTokens",
    "inputUnitPrice",
    "outputUnitPrice",
    "requestUnitPrice",
    "effectiveAt",
  ])("refuses %s instead of failing at the database", (field) => {
    expect(() => update({ [field]: "1" })).toThrow(ModelAdminException);
  });

  it("names the two-call path that does work", () => {
    // A refusal that does not say what to do instead sends the operator to
    // read the DDL, which is where this defect came from in the first place.
    let message = "";
    try {
      update({ inputUnitPrice: "0.005" });
    } catch (error) {
      message = (error as ModelAdminException).message;
    }
    expect(message).toContain("POST /capability/price-rules");
    expect(message).toContain("expiresAt");
  });

  it("reports every refused field, not just the first", () => {
    let message = "";
    try {
      update({ inputUnitPrice: "1", currency: "USD" });
    } catch (error) {
      message = (error as ModelAdminException).message;
    }
    expect(message).toContain("currency");
    expect(message).toContain("inputUnitPrice");
  });

  it("still allows expiresAt - the column the database does grant", () => {
    // This is half of the supported path: append the new version, then expire
    // this one. Refusing it too would leave no way to retire a price at all.
    expect(update({ expiresAt: "2026-12-31T00:00:00Z" })).toHaveProperty(
      "expiresAt",
    );
    expect(update({})).toEqual({});
  });
});

/**
 * TD-039, measured 2026-08-17 by running each UPDATE as `atlas_svc` against a
 * real database rather than by reading the DDL:
 *
 *   model.model_policies.tenant_id     permission denied
 *   model.model_policies.effective_at  permission denied
 *
 * Both reached Prisma before these guards - the repository passes `data: input`
 * straight through - so both were 500s on an operator route, with no type
 * error, no test failure and no lint warning upstream of them.
 */
describe("normalizeUpdatePolicy refuses columns the database will not write", () => {
  const normalizeUpdatePolicy = (body: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).normalizeUpdatePolicy(body) as ReturnType<
      ModelAdminService["updatePolicy"]
    >;

  it("refuses tenantId - a policy belongs to the tenant it was created for", () => {
    // Retargeting is not an edit: the old tenant's limits would silently stop
    // applying, one row changed, and the audit trail would not say whose
    // limits moved.
    expect(() => normalizeUpdatePolicy({ tenantId: "t-2" })).toThrow(
      /tenantId cannot be changed/,
    );
  });

  it("refuses effectiveAt - when a policy starts is fixed at create", () => {
    expect(() =>
      normalizeUpdatePolicy({ effectiveAt: "2026-01-01T00:00:00.000Z" }),
    ).toThrow(/effectiveAt cannot be changed/);
  });

  it("still accepts every field the database does grant", () => {
    // The guard must not overreach - these ARE in the column-lock list.
    const result = normalizeUpdatePolicy({
      name: "tighter",
      priority: 3,
      maxConcurrent: 4,
      rateLimitRpm: 60,
      maxContextTokens: 8000,
      expiresAt: null,
    });
    expect(result).toMatchObject({ name: "tighter", priority: 3 });
  });
});
