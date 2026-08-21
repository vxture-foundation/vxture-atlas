import { describe, expect, it, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";

import { AuditService } from "./audit.service";
import { prisma } from "../prisma";

vi.mock("../prisma", () => ({
  prisma: {
    changeRecord: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

const changeRecord = prisma.changeRecord as unknown as {
  create: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
};

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "aud-1",
    objectType: "providers",
    objectId: "prov-1",
    action: "deactivate",
    actorId: "opr_1",
    actorConsole: "console",
    changedFields: [],
    requestId: null,
    outcome: "success",
    occurredAt: new Date("2026-08-13T10:00:00.000Z"),
    ...overrides,
  };
}

describe("AuditService.record", () => {
  beforeEach(() => {
    changeRecord.create.mockClear().mockResolvedValue({});
  });

  // The write args are pinned by NAME, exhaustively, because nothing else can
  // pin them. `PrismaArgs` is `Record<string, unknown>` (src/prisma.ts), so
  // every Prisma call in this repo passes its arguments untyped - a renamed
  // field compiles perfectly, Prisma rejects the unknown argument at runtime,
  // and `AuditService.record` swallows that into `logger.error` by design. The
  // operator plane keeps answering 200 while the change trail stops recording.
  // A field renamed in the schema and missed here fails THIS test instead.
  it("writes exactly the X-3 field names, and no retired one", async () => {
    await new AuditService().record({
      objectType: "providers",
      objectId: "prov-1",
      action: "deactivate",
      actorId: "opr_1",
      actorConsole: "console",
      changedFields: ["isActive"],
      requestId: "req-1",
      outcome: "success",
    });

    const [args] = changeRecord.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(Object.keys(args.data).sort()).toEqual([
      "action",
      "actorConsole",
      "actorId",
      "changedFields",
      "objectId",
      "objectType",
      "outcome",
      "requestId",
    ]);
  });

  it("writes the trail row", async () => {
    await new AuditService().record({
      objectType: "providers",
      objectId: "prov-1",
      action: "deactivate",
      actorId: "opr_1",
      changedFields: [],
      outcome: "success",
    });

    expect(changeRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        objectType: "providers",
        objectId: "prov-1",
        action: "deactivate",
        actorId: "opr_1",
        outcome: "success",
      }),
    });
  });

  it("never throws into the caller when the audit write fails", async () => {
    // Losing the record of a deactivation is bad; refusing to let an operator
    // deactivate a failing provider mid-incident is worse.
    changeRecord.create.mockRejectedValue(new Error("audit table is full"));

    await expect(
      new AuditService().record({
        objectType: "providers",
        objectId: "prov-1",
        action: "deactivate",
        actorId: "opr_1",
        changedFields: [],
        outcome: "success",
      }),
    ).resolves.toBeUndefined();
  });

  it("truncates oversized values instead of failing the insert", async () => {
    await new AuditService().record({
      objectType: "x".repeat(200),
      objectId: "y".repeat(300),
      action: "z".repeat(100),
      actorId: "o".repeat(300),
      changedFields: [],
      outcome: "success",
    });

    const data = changeRecord.create.mock.calls[0]?.[0].data;
    expect(data.objectType).toHaveLength(64);
    expect(data.objectId).toHaveLength(128);
    expect(data.action).toHaveLength(32);
    expect(data.actorId).toHaveLength(128);
  });
});

describe("AuditService.search", () => {
  beforeEach(() => {
    changeRecord.findMany.mockClear().mockResolvedValue([]);
  });

  it("answers 'who deactivated this provider' by resource", async () => {
    changeRecord.findMany.mockResolvedValue([makeRow()]);

    const result = await new AuditService().search({
      objectType: "providers",
      objectId: "prov-1",
    });

    expect(changeRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          objectType: "providers",
          objectId: "prov-1",
        }),
        orderBy: [{ occurredAt: "desc" }, { eventId: "desc" }],
      }),
    );
    expect(result.items[0]?.actorId).toBe("opr_1");
  });

  it("returns no cursor on a short page", async () => {
    changeRecord.findMany.mockResolvedValue([makeRow()]);
    const result = await new AuditService().search({ limit: "50" });
    expect(result.nextCursor).toBeNull();
  });

  it("returns a cursor on a full page", async () => {
    // A full page is not proof of a next one, but claiming "no more" on a full
    // page is the error that silently truncates a trail.
    changeRecord.findMany.mockResolvedValue([makeRow(), makeRow({ eventId: "aud-2" })]);
    const result = await new AuditService().search({ limit: "2" });
    expect(result.nextCursor).not.toBeNull();
  });

  it("round-trips its own cursor", async () => {
    changeRecord.findMany.mockResolvedValue([makeRow()]);
    const first = await new AuditService().search({ limit: "1" });

    await new AuditService().search({ cursor: first.nextCursor as string });

    const where = changeRecord.findMany.mock.calls[1]?.[0].where;
    expect(where.OR).toEqual([
      { occurredAt: { lt: new Date("2026-08-13T10:00:00.000Z") } },
      // The cursor PAYLOAD still spells its key `id` - it is opaque, and
      // renaming it would invalidate every cursor a console is holding. The
      // FIELD the query reads moved to eventId; only that is a contract.
      { occurredAt: new Date("2026-08-13T10:00:00.000Z"), eventId: { lt: "aud-1" } },
    ]);
  });

  it("caps the page size rather than honouring an unbounded limit", async () => {
    await new AuditService().search({ limit: "100000" });
    expect(changeRecord.findMany.mock.calls[0]?.[0].take).toBe(200);
  });

  it("rejects a malformed cursor instead of silently restarting the page", async () => {
    // Silently restarting is the dangerous failure: an auditor paging through
    // a trail would see the first page again and read it as the end.
    await expect(
      new AuditService().search({ cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a well-formed cursor carrying a nonsense payload", async () => {
    // base64url that decodes to valid JSON, so only the payload check catches
    // it - a hand-built token, which is exactly why the encoding is opaque.
    const forged = Buffer.from(
      JSON.stringify({ occurredAt: "the beginning of time", id: 7 }),
    ).toString("base64url");

    await expect(
      new AuditService().search({ cursor: forged }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("accepts a from/to window", async () => {
    await new AuditService().search({
      from: "2026-08-01T00:00:00Z",
      to: "2026-08-13T00:00:00Z",
    });

    expect(changeRecord.findMany.mock.calls[0]?.[0].where.occurredAt).toEqual({
      gte: new Date("2026-08-01T00:00:00Z"),
      lte: new Date("2026-08-13T00:00:00Z"),
    });
  });

  it("rejects an unparseable date", async () => {
    await expect(
      new AuditService().search({ from: "yesterday" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an outcome outside the two real values", async () => {
    await expect(
      new AuditService().search({ outcome: "maybe" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a non-positive limit", async () => {
    await expect(
      new AuditService().search({ limit: "0" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
