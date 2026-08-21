import { describe, it, expect } from "vitest";

import { readSseMessages } from "./sse";
import { collect, streamOf } from "./stream.fixtures";

describe("readSseMessages", () => {
  it("reassembles an event split across chunk boundaries", async () => {
    const messages = await collect(
      readSseMessages(streamOf('data: {"a"', ':1}\n', "\n")),
    );

    expect(messages.map((m) => m.data)).toEqual(['{"a":1}']);
  });

  it("handles a multi-byte character split across chunk boundaries", async () => {
    // "你" is 3 bytes in UTF-8 - cut it in half across two chunks.
    const encoder = new TextEncoder();
    const bytes = encoder.encode("data: 你好\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });

    const messages = await collect(readSseMessages(stream));
    expect(messages.map((m) => m.data)).toEqual(["你好"]);
  });

  it("accepts CRLF line endings", async () => {
    const messages = await collect(
      readSseMessages(streamOf("data: one\r\n\r\ndata: two\r\n\r\n")),
    );

    expect(messages.map((m) => m.data)).toEqual(["one", "two"]);
  });

  it("joins multi-line data payloads with a newline", async () => {
    const messages = await collect(
      readSseMessages(streamOf("data: line1\ndata: line2\n\n")),
    );

    expect(messages.map((m) => m.data)).toEqual(["line1\nline2"]);
  });

  it("ignores comment lines used as heartbeats", async () => {
    const messages = await collect(
      readSseMessages(streamOf(": keep-alive\n\ndata: real\n\n")),
    );

    expect(messages.map((m) => m.data)).toEqual(["real"]);
  });

  it("exposes the event name when the server sends one", async () => {
    const messages = await collect(
      readSseMessages(streamOf("event: message_stop\ndata: {}\n\n")),
    );

    expect(messages[0]?.event).toBe("message_stop");
  });

  it("drops a trailing event that was never terminated by a blank line", async () => {
    // Per the SSE spec an unterminated event at EOF is discarded, and
    // `eventsource-parser` follows the spec. Pinned as a known boundary:
    // a provider that truncates its last frame loses that frame's usage,
    // which is why parseOpenAiCompatibleStream/parseClaudeStream must still
    // emit a `done` event from whatever they accumulated.
    const messages = await collect(
      readSseMessages(streamOf('data: {"complete":true}\n\ndata: {"cut":')),
    );

    expect(messages.map((m) => m.data)).toEqual(['{"complete":true}']);
  });
});
