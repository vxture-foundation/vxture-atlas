import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleProvider } from "./openai-compatible.provider";
import { parseProviderParseResponse } from "./parse-vision";

/**
 * The A2 parse path made one upstream call per page, summed usage across all
 * of them, and returned only the first page's structure (`first ??= parsed`).
 * An N-page parse therefore cost N upstream calls, billed N pages, and answered
 * with page one - well-formed, and undetectable from the caller's side.
 *
 * 852 tests passed with that bug in place, because none of them ever sent a
 * second page. So these send a second page.
 */

function ocrFrame(text: string): { choices: Array<{ message: { content: string } }>; usage: Record<string, number> } {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            task: "ocr",
            spans: [{ bbox: [0, 0, 0.5, 0.25], text }],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeProvider(pageTexts: string[]): {
  provider: OpenAiCompatibleProvider;
  postJson: ReturnType<typeof vi.fn>;
} {
  const provider = new OpenAiCompatibleProvider();
  const postJson = vi.fn();
  for (const text of pageTexts) postJson.mockResolvedValueOnce(ocrFrame(text));
  // `postJson` is the single upstream seam on BaseProvider.
  (provider as unknown as { postJson: unknown }).postJson = postJson;
  return { provider, postJson };
}

const REQUEST = {
  endpointUrl: "https://example.com/v1",
  apiKey: "k",
  modelCode: "vision-1",
  // parseDocument is gated on an explicit registry act, not on the protocol:
  // a model does not become a document parser by speaking OpenAI's wire format.
  config: { supportsVision: true },
  task: "ocr" as const,
  pages: [
    { pageIndex: 0, imageRef: "page-0" },
    { pageIndex: 1, imageRef: "page-1" },
    { pageIndex: 2, imageRef: "page-2" },
  ],
};

describe("A2 parse over multiple pages", () => {
  it("returns every page, not just the first", async () => {
    const { provider } = makeProvider(["page zero", "page one", "page two"]);

    const result = await provider.parseDocument(REQUEST);

    // Narrow on the discriminant first - that is the shape's whole point: a
    // caller switches once on `task`, not once per page.
    if (result.task !== "ocr") throw new Error(`unexpected task ${result.task}`);
    expect(result.pages).toHaveLength(3);
    expect(result.pages.map((page) => page.spans[0]?.text)).toEqual([
      "page zero",
      "page one",
      "page two",
    ]);
  });

  it("echoes each pageIndex from the request rather than relying on order", async () => {
    // A caller correlating results back to its own pages by array position is
    // one upstream retry away from mismatching them.
    const { provider } = makeProvider(["a", "b", "c"]);

    const result = await provider.parseDocument(REQUEST);

    expect(result.pages.map((page) => page.pageIndex)).toEqual([0, 1, 2]);
  });

  it("makes exactly one upstream call per page", async () => {
    // This is the half that made the old behaviour expensive rather than just
    // wrong: the pages were fetched and paid for, then thrown away.
    const { provider, postJson } = makeProvider(["a", "b", "c"]);

    await provider.parseDocument(REQUEST);

    expect(postJson).toHaveBeenCalledTimes(3);
  });

  it("sums usage across the pages it actually returns", async () => {
    const { provider } = makeProvider(["a", "b", "c"]);

    const result = await provider.parseDocument(REQUEST);

    // 3 pages x 15 total tokens. Billing and content now describe the same
    // work; before, usage counted three pages and the body carried one.
    expect(result.usage).toEqual({
      promptTokens: 30,
      completionTokens: 15,
      totalTokens: 45,
    });
  });

  it("names the failing page when one page's answer is unusable", async () => {
    // With N calls behind one request, "the model returned no content" is
    // unactionable without the index.
    const provider = new OpenAiCompatibleProvider();
    const postJson = vi
      .fn()
      .mockResolvedValueOnce(ocrFrame("fine"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "  " } }] });
    (provider as unknown as { postJson: unknown }).postJson = postJson;

    await expect(
      provider.parseDocument({
        ...REQUEST,
        pages: [
          { pageIndex: 0, imageRef: "a" },
          { pageIndex: 7, imageRef: "b" },
        ],
      }),
    ).rejects.toThrow(/page 7/);
  });
});

describe("parseProviderParseResponse over multiple pages", () => {
  it("keeps each page's structure separate", () => {
    const result = parseProviderParseResponse("ocr", [
      { pageIndex: 4, rawContent: '{"spans":[{"bbox":[0,0,0.1,0.1],"text":"x"}]}' },
      { pageIndex: 9, rawContent: '{"spans":[{"bbox":[0,0,0.2,0.2],"text":"y"}]}' },
    ]);

    expect(result).toEqual({
      task: "ocr",
      pages: [
        { pageIndex: 4, spans: [{ bbox: [0, 0, 0.1, 0.1], text: "x" }] },
        { pageIndex: 9, spans: [{ bbox: [0, 0, 0.2, 0.2], text: "y" }] },
      ],
    });
  });

  it("names the page whose JSON is malformed", () => {
    expect(() =>
      parseProviderParseResponse("ocr", [
        { pageIndex: 0, rawContent: '{"spans":[]}' },
        { pageIndex: 3, rawContent: "not json at all" },
      ]),
    ).toThrow(/page 3/);
  });
});
