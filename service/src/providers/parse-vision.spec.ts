/**
 * parse-vision.spec.ts - A2 parse over a vision model
 * @package @atlas/service
 * @layer Domain
 * @category test
 */
import { describe, expect, it } from "vitest";

import {
  buildParseMessages,
  parseProviderParseResponse,
  stripJsonFence,
  toImageUrl,
} from "./parse-vision";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";

describe("toImageUrl", () => {
  it("sniffs the mime type from the base64 magic bytes", () => {
    // Declaring the wrong type is rejected by some upstreams and silently
    // mis-decoded by others, and the second outcome yields a confident parse
    // of a corrupted image.
    expect(toImageUrl({ pageIndex: 0, imageBase64: PNG_B64 })).toBe(
      `data:image/png;base64,${PNG_B64}`,
    );
    expect(toImageUrl({ pageIndex: 0, imageBase64: "/9j/4AAQSkZJRg==" })).toBe(
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    );
  });

  it("passes imageRef through as a url", () => {
    const ref = "https://example.invalid/page-1.png";
    expect(toImageUrl({ pageIndex: 0, imageRef: ref })).toBe(ref);
  });

  it("throws when a page carries no image at all", () => {
    expect(() => toImageUrl({ pageIndex: 3 })).toThrow(/page 3/);
  });
});

describe("buildParseMessages", () => {
  it("sends the image as a content part and names the task", () => {
    const messages = buildParseMessages("ocr", {
      pageIndex: 2,
      imageBase64: PNG_B64,
    });
    const user = messages[1] as { content: Array<Record<string, unknown>> };

    expect(user.content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG_B64}` },
    });
    expect(JSON.stringify(messages)).toContain("page 2");
  });

  it("asks for the shape the task actually returns", () => {
    // A layout prompt that described the OCR shape would produce answers this
    // module then rejects - the failure would look like a bad model rather
    // than a bad prompt.
    expect(JSON.stringify(buildParseMessages("table", { pageIndex: 0, imageRef: "x" })))
      .toContain("rowSpan");
    expect(JSON.stringify(buildParseMessages("formula", { pageIndex: 0, imageRef: "x" })))
      .toContain("latex");
  });
});

describe("stripJsonFence", () => {
  it("removes a fence the model was told not to add", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("parseProviderParseResponse", () => {
  it("accepts a well-formed layout answer", () => {
    const result = parseProviderParseResponse("layout", [
        { pageIndex: 0, rawContent: '{"task":"layout","blocks":[{"bbox":[0,0,0.5,0.25],"blockType":"title"}]}' },
      ]);
    expect(result).toEqual({
      task: "layout",
      pages: [
        {
          pageIndex: 0,
          blocks: [{ bbox: [0, 0, 0.5, 0.25], blockType: "title" }],
        },
      ],
    });
  });

  it("accepts a table answer and keeps span information", () => {
    const result = parseProviderParseResponse("table", [
        { pageIndex: 0, rawContent: '{"task":"table","rows":2,"cols":2,"cells":[{"rowSpan":2,"colSpan":1,"text":"a","bbox":[0,0,0.1,0.2]}]}' },
      ]);
    expect(result).toMatchObject({
      task: "table",
      pages: [{ pageIndex: 0, rows: 2, cols: 2 }],
    });
  });

  it("rejects a bbox in pixel space instead of silently passing it on", () => {
    // The single most likely wrong answer: a model reporting 1240 for a page
    // 1240px wide. Downstream it would read as a box a thousand pages wide,
    // which is a wrong answer wearing the costume of a right one.
    expect(() =>
      parseProviderParseResponse("ocr", [
        { pageIndex: 0, rawContent: '{"task":"ocr","spans":[{"bbox":[0,0,1240,1750],"text":"hi"}]}' },
      ]),
    ).toThrow(/outside 0\.\.1/);
  });

  it("rejects an inverted bbox", () => {
    expect(() =>
      parseProviderParseResponse("ocr", [
        { pageIndex: 0, rawContent: '{"task":"ocr","spans":[{"bbox":[0.9,0.9,0.1,0.1],"text":"hi"}]}' },
      ]),
    ).toThrow(/inverted/);
  });

  it("rejects a bbox that is not four numbers", () => {
    expect(() =>
      parseProviderParseResponse("formula", [
        { pageIndex: 0, rawContent: '{"task":"formula","latex":"x^2","bbox":[0,0,1]}' },
      ]),
    ).toThrow(/4 numbers/);
  });

  it("rejects non-JSON rather than returning something partial", () => {
    // Parse feeds downstream extraction. A table quietly missing its last row
    // is worse than an error, because nothing downstream can detect it.
    expect(() => parseProviderParseResponse("ocr", [
        { pageIndex: 0, rawContent: "I could not read that" },
      ])).toThrow(
      /not JSON/,
    );
  });

  it("rejects a missing collection instead of defaulting to empty", () => {
    // An empty page must be the model SAYING empty, not this code inventing it
    // from a malformed answer - otherwise "nothing on the page" and "the model
    // failed" become indistinguishable.
    expect(() => parseProviderParseResponse("layout", [
        { pageIndex: 0, rawContent: '{"task":"layout"}' },
      ])).toThrow(
      /blocks/,
    );
  });

  it("tolerates a fenced answer, since models add fences under instruction not to", () => {
    const result = parseProviderParseResponse("formula", [
        { pageIndex: 0, rawContent: '```json\n{"task":"formula","latex":"e^{i\\\\pi}+1=0","bbox":[0,0,1,1]}\n```' },
      ]);
    expect(result).toMatchObject({ task: "formula" });
  });
});
