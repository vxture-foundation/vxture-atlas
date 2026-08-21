import { afterEach, describe, it, expect, vi } from "vitest";

import { ZhipuProvider } from "./zhipu.provider";

describe("ZhipuProvider", () => {
  it("identifies itself as zhipu", () => {
    expect(new ZhipuProvider().providerName).toBe("zhipu");
  });
});

function mockJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ZhipuProvider.embed", () => {
  it("posts to <endpoint>/embeddings and returns index-ordered vectors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        model: "embedding-3",
        object: "list",
        // deliberately out of order - embed() must sort by index, not trust array order
        data: [
          { index: 1, object: "embedding", embedding: [0.4, 0.5] },
          { index: 0, object: "embedding", embedding: [0.1, 0.2] },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ZhipuProvider();
    const result = await provider.embed({
      endpointUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "key",
      modelCode: "embedding-3",
      texts: ["a", "b"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.bigmodel.cn/api/paas/v4/embeddings",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      model: "embedding-3",
      input: ["a", "b"],
    });
    expect(result).toEqual({
      modelVersion: "embedding-3",
      dimension: 2,
      vectors: [
        [0.1, 0.2],
        [0.4, 0.5],
      ],
    });
  });

  it("sends config.upstreamModel instead of modelCode when set (platform#152)", async () => {
    // Once the registry row is renamed to the prefixed convention
    // (e.g. zhipu/embedding-3) with upstreamModel: "embedding-3" set, the
    // wire body must still send the bare vendor id, not the dispatch key.
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        model: "embedding-3",
        object: "list",
        data: [{ index: 0, object: "embedding", embedding: [0.1, 0.2] }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ZhipuProvider();
    await provider.embed({
      endpointUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "key",
      modelCode: "zhipu/embedding-3",
      config: { upstreamModel: "embedding-3" },
      texts: ["a"],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "embedding-3",
    });
  });
});

describe("ZhipuProvider.rerank", () => {
  it("posts bare document strings and correlates results back to candidate ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        id: "task-1",
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ZhipuProvider();
    const result = await provider.rerank({
      endpointUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "key",
      modelCode: "rerank",
      query: "q",
      candidates: [
        { id: "c-a", text: "candidate A" },
        { id: "c-b", text: "candidate B" },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.bigmodel.cn/api/paas/v4/rerank",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      model: "rerank",
      query: "q",
      documents: ["candidate A", "candidate B"],
    });
    expect(result).toEqual({
      scores: [
        { id: "c-b", score: 0.9 },
        { id: "c-a", score: 0.2 },
      ],
    });
  });
});
