import { StorageError } from "../errors.js";
import type { GraphClient } from "./client.js";

/** Version of the graph layout marker. Bump only together with a documented migration. */
export const GRAPH_SCHEMA_VERSION = 1;

/** A range index on one node property, optionally with a unique constraint. */
export interface IndexSpec {
  label: string;
  property: string;
  unique?: boolean;
}

/** The marker node every bootstrapped graph carries. */
const META_SPEC: IndexSpec = { label: "Meta", property: "id", unique: true };

/**
 * Index specs for the persisted records. Ticket owners append specs here next to the
 * repository functions they add (for example `{ label: "Call", property: "id", unique: true }`);
 * the server passes this list to `bootstrapSchema` at startup.
 */
export const INDEX_SPECS: readonly IndexSpec[] = [];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BootstrapReport {
  graph: string;
  schemaVersion: number;
  indexesCreated: number;
  constraintsCreated: number;
  /** True when this run created the schema marker (first start on this graph). */
  freshGraph: boolean;
}

interface IndexRow extends Record<string, unknown> {
  label: string;
  properties: string[];
}
interface ConstraintRow extends Record<string, unknown> {
  label: string;
  properties: string[];
  status: string;
}

async function listIndexes(db: GraphClient): Promise<Set<string>> {
  try {
    const rows = await db.roQuery<IndexRow>("CALL db.indexes() YIELD label, properties RETURN label, properties", {}, "listing indexes");
    return new Set(rows.flatMap((row) => row.properties.map((property) => `${row.label}.${property}`)));
  } catch (error) {
    // A graph key that does not exist yet has no indexes.
    if (error instanceof StorageError && error.code === "internal_error") return new Set();
    throw error;
  }
}

async function listConstraints(db: GraphClient): Promise<Map<string, string>> {
  try {
    const rows = await db.roQuery<ConstraintRow>("CALL db.constraints() YIELD label, properties, status RETURN label, properties, status", {}, "listing constraints");
    return new Map(rows.flatMap((row) => row.properties.map((property) => [`${row.label}.${property}`, row.status] as const)));
  } catch (error) {
    if (error instanceof StorageError && error.code === "internal_error") return new Map();
    throw error;
  }
}

async function waitForConstraints(db: GraphClient, expected: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await listConstraints(db);
    const pending = expected.filter((key) => current.get(key) !== "OPERATIONAL");
    if (pending.length === 0) return;
    if (Date.now() > deadline) {
      throw new StorageError("storage_unavailable", `Unique constraints did not become operational within ${timeoutMs} ms: ${pending.join(", ")}`, { outcomeCertainty: "not_executed" });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Idempotent schema bootstrap: creates the missing indexes and unique constraints from `specs`
 * (plus the Meta marker) and writes the schema marker. Re-running never drops or rewrites
 * existing data, and creates nothing the second time. A graph written by a different schema
 * version fails with a descriptive error instead of being silently reused.
 */
export async function bootstrapSchema(db: GraphClient, specs: readonly IndexSpec[] = INDEX_SPECS): Promise<BootstrapReport> {
  const all: IndexSpec[] = [META_SPEC];
  for (const spec of specs) {
    if (!IDENTIFIER.test(spec.label) || !IDENTIFIER.test(spec.property)) {
      throw new TypeError(`Invalid index spec ${spec.label}.${spec.property}: labels and properties must match ${IDENTIFIER}`);
    }
    if (!all.some((existing) => existing.label === spec.label && existing.property === spec.property)) all.push(spec);
  }

  const existingIndexes = await listIndexes(db);
  let indexesCreated = 0;
  for (const spec of all) {
    const key = `${spec.label}.${spec.property}`;
    if (existingIndexes.has(key)) continue;
    await db.createRangeIndex(spec.label, spec.property);
    existingIndexes.add(key);
    indexesCreated += 1;
  }

  const existingConstraints = await listConstraints(db);
  let constraintsCreated = 0;
  const uniqueKeys: string[] = [];
  for (const spec of all.filter((candidate) => candidate.unique === true)) {
    const key = `${spec.label}.${spec.property}`;
    uniqueKeys.push(key);
    if (existingConstraints.has(key)) continue;
    await db.createUniqueConstraint(spec.label, spec.property);
    constraintsCreated += 1;
  }
  await waitForConstraints(db, uniqueKeys, 15_000);

  const rows = await db.query<{ schema_version: number; fresh: boolean }>(
    `MERGE (m:Meta {id: 'schema'})
     ON CREATE SET m.schema_version = $version, m.created_at = $now, m.fresh = true
     RETURN m.schema_version AS schema_version, m.created_at = $now AS fresh`,
    { version: GRAPH_SCHEMA_VERSION, now: new Date().toISOString() },
    "writing the schema marker",
  );
  const marker = rows[0];
  if (!marker) throw new StorageError("internal_error", "Schema marker query returned no rows");
  if (marker.schema_version !== GRAPH_SCHEMA_VERSION) {
    throw new StorageError(
      "storage_unavailable",
      `Graph "${db.graphName}" has schema_version ${marker.schema_version} but this build supports ${GRAPH_SCHEMA_VERSION}. ` +
        "Point FALKORDB_GRAPH at a different graph or migrate the data; the server will not reuse an incompatible graph.",
      { outcomeCertainty: "not_executed", retryable: false },
    );
  }
  return { graph: db.graphName, schemaVersion: marker.schema_version, indexesCreated, constraintsCreated, freshGraph: marker.fresh };
}

/** Health probe: connectivity plus schema compatibility, without writing. */
export async function readSchemaVersion(db: GraphClient): Promise<number> {
  const rows = await db.roQuery<{ schema_version: number }>("MATCH (m:Meta {id: 'schema'}) RETURN m.schema_version AS schema_version", {}, "reading the schema marker").catch((error: unknown) => {
    if (error instanceof StorageError && error.code === "internal_error") return [];
    throw error;
  });
  const version = rows[0]?.schema_version;
  if (version === undefined) {
    throw new StorageError("storage_unavailable", `Graph "${db.graphName}" has not been bootstrapped; restart the server to create its schema`, { outcomeCertainty: "not_executed" });
  }
  if (version !== GRAPH_SCHEMA_VERSION) {
    throw new StorageError("storage_unavailable", `Graph "${db.graphName}" has schema_version ${version}, expected ${GRAPH_SCHEMA_VERSION}`, { outcomeCertainty: "not_executed" });
  }
  return version;
}
