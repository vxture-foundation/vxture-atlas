/**
 * parse-vision.ts - A2 document parse over an OpenAI-compatible vision model
 * @package @atlas/service
 * @layer Domain
 * @category provider
 *
 * @description
 *   Serves `/v1/parse` by asking a vision-capable chat model for the exact
 *   structure `ProviderParseResponse` declares, then validating the answer
 *   before it is allowed to leave.
 *
 *   WHY HERE AND NOT IN A PROVIDER. Which model parses documents is a registry
 *   decision, not a code decision - that is the whole premise of this service.
 *   Implementing this on the OpenAI-compatible adapter means any provider
 *   speaking that protocol can back parse the moment a vision model is
 *   registered for it, with no adapter written and nothing redeployed. Binding
 *   it to one vendor would have made "which provider does parse" a question
 *   only a release could answer.
 *
 *   WHAT THIS IS NOT. A vision LLM is not a dedicated document-parsing engine.
 *   It will return the right SHAPE - that is enforced below - but bounding-box
 *   precision is a property of the model an operator registers, not of this
 *   code. Callers that need survey-grade geometry should treat the choice of
 *   model as the thing to evaluate, and `/capability/models` is where that
 *   choice is visible. Saying this plainly is the point: the alternative is a
 *   contract that looks equally authoritative whatever sits behind it.
 *
 *   VALIDATION IS DELIBERATELY STRICT. A malformed answer throws rather than
 *   degrading into partial output. Parse feeds downstream extraction; a table
 *   silently missing its last row is worse than an error, because nothing
 *   downstream can tell that it happened.
 */
import type {
  ParseTask,
  ProviderParsePage,
  ProviderParseResponse,
} from "../types/runtime.types";

/** What the model is told to return, per task. Mirrors ProviderParseResponse. */
const SCHEMA_BY_TASK: Record<ParseTask, string> = {
  layout:
    '{"task":"layout","blocks":[{"bbox":[x0,y0,x1,y1],"blockType":"<title|paragraph|figure|table|list|header|footer>"}]}',
  ocr: '{"task":"ocr","spans":[{"bbox":[x0,y0,x1,y1],"text":"<verbatim text>"}]}',
  table:
    '{"task":"table","rows":<int>,"cols":<int>,"cells":[{"rowSpan":<int>,"colSpan":<int>,"text":"<cell text>","bbox":[x0,y0,x1,y1]}]}',
  formula: '{"task":"formula","latex":"<LaTeX>","bbox":[x0,y0,x1,y1]}',
};

const INSTRUCTION_BY_TASK: Record<ParseTask, string> = {
  layout:
    "Detect every layout region on the page and classify each one. Do not transcribe text.",
  ocr: "Transcribe every text span verbatim, preserving the original characters. Do not translate, correct or summarise.",
  table:
    "Read the single table on the page. Report merged cells through rowSpan/colSpan rather than repeating their text.",
  formula:
    "Transcribe the mathematical formula as LaTeX. Return the formula only, with no surrounding prose or delimiters.",
};

/**
 * Coordinates are normalised to 0..1 of page width/height on purpose.
 *
 * Pixel coordinates would require the model to know the raster size it was
 * handed, which it is not reliably told and cannot be asked for mid-request -
 * so a pixel contract produces numbers that look precise and are silently in
 * the wrong space. Normalised values are checkable here (below), which is why
 * the bound can be enforced rather than hoped for.
 */
const COORDINATE_NOTE =
  "All bbox values are [x0,y0,x1,y1] normalised to 0..1 of page width and height, origin at top-left.";

export function buildParseMessages(
  task: ParseTask,
  page: ProviderParsePage,
): Array<Record<string, unknown>> {
  const imageUrl = toImageUrl(page);
  return [
    {
      role: "system",
      content:
        `You extract document structure. ${INSTRUCTION_BY_TASK[task]} ${COORDINATE_NOTE} ` +
        `Reply with JSON only, exactly this shape: ${SCHEMA_BY_TASK[task]}. ` +
        "No markdown fence, no commentary. If the page contains nothing for this task, return the shape with an empty collection.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Parse page ${page.pageIndex} (task: ${task}).` },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ];
}

/**
 * `imageBase64` becomes a data URI; `imageRef` is passed through as a URL.
 *
 * The mime type is sniffed from the base64 magic bytes rather than assumed:
 * declaring `image/jpeg` over PNG bytes is rejected by some upstreams and
 * silently mis-decoded by others, and the second failure mode produces a
 * plausible-looking parse of a corrupted image.
 */
export function toImageUrl(page: ProviderParsePage): string {
  if (page.imageBase64) {
    return `data:${sniffMime(page.imageBase64)};base64,${page.imageBase64}`;
  }
  if (page.imageRef) {
    return page.imageRef;
  }
  throw new Error(
    `parse page ${page.pageIndex} carries neither imageBase64 nor imageRef`,
  );
}

function sniffMime(base64: string): string {
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  // Unknown magic: PNG is the safest default for document rasters, and an
  // upstream that disagrees fails loudly on decode rather than parsing noise.
  return "image/png";
}

/** Strips a ```json fence when a model adds one despite being told not to. */
export function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * Parse every page's raw upstream content into one response.
 *
 * Takes ALL pages rather than one, so the `task` switch happens once and each
 * branch maps its own page shape - no cast anywhere, and adding a task means
 * the compiler names every place that has to handle it.
 *
 * A malformed page names its own index: with N upstream calls behind one
 * request, "the model returned no content" is unactionable without it.
 */
export function parseProviderParseResponse(
  task: ParseTask,
  pages: ReadonlyArray<{ pageIndex: number; rawContent: string }>,
): ProviderParseResponse {
  switch (task) {
    case "layout":
      return {
        task: "layout",
        pages: pages.map(({ pageIndex, rawContent }) => ({
          pageIndex,
          blocks: requireArray(
            pageBody(rawContent, pageIndex)["blocks"],
            "blocks",
          ).map((entry) => {
            const block = requireObject(entry, "block");
            return {
              bbox: requireBbox(block["bbox"]),
              blockType: requireString(block["blockType"], "blockType"),
            };
          }),
        })),
      };
    case "ocr":
      return {
        task: "ocr",
        pages: pages.map(({ pageIndex, rawContent }) => ({
          pageIndex,
          spans: requireArray(
            pageBody(rawContent, pageIndex)["spans"],
            "spans",
          ).map((entry) => {
            const span = requireObject(entry, "span");
            return {
              bbox: requireBbox(span["bbox"]),
              text: requireString(span["text"], "text"),
            };
          }),
        })),
      };
    case "table":
      return {
        task: "table",
        pages: pages.map(({ pageIndex, rawContent }) => {
          const body = pageBody(rawContent, pageIndex);
          return {
            pageIndex,
            rows: requireInt(body["rows"], "rows"),
            cols: requireInt(body["cols"], "cols"),
            cells: requireArray(body["cells"], "cells").map((entry) => {
              const cell = requireObject(entry, "cell");
              return {
                rowSpan: requireInt(cell["rowSpan"], "rowSpan"),
                colSpan: requireInt(cell["colSpan"], "colSpan"),
                text: requireString(cell["text"], "text"),
                bbox: requireBbox(cell["bbox"]),
              };
            }),
          };
        }),
      };
    case "formula":
      return {
        task: "formula",
        pages: pages.map(({ pageIndex, rawContent }) => {
          const body = pageBody(rawContent, pageIndex);
          return {
            pageIndex,
            latex: requireString(body["latex"], "latex"),
            bbox: requireBbox(body["bbox"]),
          };
        }),
      };
  }
}

function pageBody(rawContent: string, pageIndex: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonFence(rawContent));
  } catch {
    throw new Error(
      `parse model returned content that is not JSON for page ${pageIndex}`,
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`parse model returned a non-object for page ${pageIndex}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`parse model response is missing array field "${field}"`);
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`parse model response has a non-object ${field}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`parse model response field "${field}" is not a string`);
  }
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`parse model response field "${field}" is not a number`);
  }
  return Math.round(value);
}

/**
 * Four finite numbers in 0..1, x0<=x1 and y0<=y1.
 *
 * The range check is what makes the normalised contract real rather than
 * documentation. A model that answers in pixels produces values like 1240,
 * which would otherwise flow downstream as a box a thousand pages wide - a
 * wrong answer that looks like a right one. Rejecting here turns a silent
 * coordinate-space mismatch into a visible provider error.
 */
function requireBbox(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("parse model response has a bbox that is not 4 numbers");
  }
  const bbox = value.map((n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      throw new Error("parse model response has a non-numeric bbox value");
    }
    if (n < 0 || n > 1) {
      throw new Error(
        `parse model response has bbox value ${n} outside 0..1 - the model answered in a different coordinate space`,
      );
    }
    return n;
  });
  if (bbox[0]! > bbox[2]! || bbox[1]! > bbox[3]!) {
    throw new Error("parse model response has an inverted bbox");
  }
  return bbox;
}
