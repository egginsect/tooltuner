/**
 * Integration tests against a real FalkorDB at FALKORDB_URL (default redis://127.0.0.1:6379).
 * Start it with: docker compose up -d falkordb. Each run uses a throwaway graph name and drops it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GRAPH_SCHEMA_VERSION, GraphClient, bootstrapSchema, readSchemaVersion, type IndexSpec } from "../../src/db/index.js";
import { StorageError } from "../../src/errors.js";

const url = process.env["FALKORDB_URL"] && process.env["FALKORDB_URL"] !== "" ? process.env["FALKORDB_URL"] : "redis://127.0.0.1:6379";
const graphName = `flywheel_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const specs: IndexSpec[] = [
  { label: "Thing", property: "id", unique: true },
  { label: "Thing", property: "kind", unique: false },
];

let db: GraphClient;

beforeAll(async () => {
  db = await GraphClient.connect({ url, graph: graphName });
});

afterAll(async () => {
  await db?.dropGraph();
  await db?.close();
});

describe("index bootstrap", () => {
  it("creates indexes, constraints and the schema marker once, then is idempotent", async () => {
    const first = await bootstrapSchema(db, specs);
    expect(first).toMatchObject({ graph: graphName, schemaVersion: GRAPH_SCHEMA_VERSION, freshGraph: true });
    expect(first.indexesCreated).toBe(3); // Meta.id + Thing.id + Thing.kind
    expect(first.constraintsCreated).toBe(2); // Meta.id + Thing.id

    const second = await bootstrapSchema(db, specs);
    expect(second).toMatchObject({ schemaVersion: GRAPH_SCHEMA_VERSION, indexesCreated: 0, constraintsCreated: 0, freshGraph: false });
    expect(await readSchemaVersion(db)).toBe(GRAPH_SCHEMA_VERSION);
  });

  it("rejects an invalid index spec before touching the database", async () => {
    await expect(bootstrapSchema(db, [{ label: "Bad Label", property: "id" }])).rejects.toThrow(TypeError);
  });
});

describe("write/read round trip", () => {
  it("stores and reads back the same record, including awkward characters, using parameters only", async () => {
    const id = `thing_${randomUUID()}`;
    const doc = JSON.stringify({ note: "quote \" backslash \\ unicode \u00e9 newline \n", nested: { list: [1, 2, 3] } });
    await db.query("CREATE (:Thing {id: $id, kind: $kind, doc: $doc, tags: $tags})", { id, kind: "synthetic", doc, tags: ["a", "b"] }, "writing a thing");

    const rows = await db.roQuery<{ id: string; doc: string; tags: string[] }>("MATCH (t:Thing {id: $id}) RETURN t.id AS id, t.doc AS doc, t.tags AS tags", { id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(JSON.parse(rows[0]?.doc ?? "null")).toEqual(JSON.parse(doc));
    expect(rows[0]?.tags).toEqual(["a", "b"]);
  });

  it("reads the same record after the client reconnects", async () => {
    const id = `thing_${randomUUID()}`;
    await db.query("CREATE (:Thing {id: $id, kind: 'persist'})", { id });
    const second = await GraphClient.connect({ url, graph: graphName });
    try {
      const rows = await second.roQuery<{ id: string }>("MATCH (t:Thing {id: $id}) RETURN t.id AS id", { id });
      expect(rows.map((row) => row.id)).toEqual([id]);
    } finally {
      await second.close();
    }
  });

  it("does not execute injected Cypher passed as a parameter value", async () => {
    const hostile = "x'}) DETACH DELETE (t) //";
    const before = await db.roQuery<{ n: number }>("MATCH (t:Thing) RETURN count(t) AS n");
    await db.query("CREATE (:Thing {id: $id, kind: 'hostile'})", { id: hostile });
    const after = await db.roQuery<{ n: number }>("MATCH (t:Thing) RETURN count(t) AS n");
    expect(after[0]?.n).toBe((before[0]?.n ?? 0) + 1);
  });

  it("enforces unique ids with a descriptive ingest_conflict error", async () => {
    const id = `thing_${randomUUID()}`;
    await db.query("CREATE (:Thing {id: $id})", { id });
    await expect(db.query("CREATE (:Thing {id: $id})", { id })).rejects.toMatchObject({ code: "ingest_conflict" });
  });

  it("makes a read-only query reject writes", async () => {
    await expect(db.roQuery("CREATE (:Thing {id: 'ro-write'})")).rejects.toBeInstanceOf(StorageError);
  });
});

describe("storage unavailable", () => {
  it("fails with an actionable storage_unavailable error instead of a fake success", async () => {
    const attempt = GraphClient.connect({ url: "redis://127.0.0.1:1", graph: "unreachable", connectTimeoutMs: 500 });
    await expect(attempt).rejects.toMatchObject({ code: "storage_unavailable", retryable: true });
    await expect(attempt).rejects.toThrow(/docker compose up -d falkordb/);
  });

  it("fails fast on a closed client", async () => {
    const closed = await GraphClient.connect({ url, graph: graphName });
    await closed.close();
    await expect(closed.query("RETURN 1")).rejects.toMatchObject({ code: "storage_unavailable" });
  });
});
