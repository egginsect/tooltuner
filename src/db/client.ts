import { FalkorDB, ConstraintType, EntityType, type FalkorDBOptions, type Graph } from "falkordb";
import { StorageError } from "../errors.js";

export interface GraphClientOptions {
  /** `redis://host:port` (or `falkor://`) URL without embedded credentials. */
  url: string;
  graph: string;
  username?: string | undefined;
  password?: string | undefined;
  /** Per-query timeout. A timed-out write has an unknown outcome. */
  queryTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Hosted startup must not wait forever for a failed connection. */
  maxReconnectAttempts?: number;
}

/** JSON-like values accepted as Cypher parameters. Values always travel as parameters, never in query text. */
export type ParamValue = null | boolean | number | string | readonly ParamValue[] | { readonly [key: string]: ParamValue };
export type QueryParams = Readonly<Record<string, ParamValue>>;
/** One result row keyed by the RETURN aliases. */
export type Row = Record<string, unknown>;

const DEFAULT_QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

/** Display-safe description of the endpoint for error messages (no credentials). */
function describeEndpoint(url: string): string {
  try {
    const parsed = new URL(url.replace(/^falkor/, "redis"));
    return `${parsed.hostname}:${parsed.port || "6379"}`;
  } catch {
    return "the configured FALKORDB_URL";
  }
}

/** True for errors the server itself returned (the driver's ErrorReply family), as opposed to socket failures. */
function isServerReplyError(error: unknown): boolean {
  for (let proto: unknown = error; proto !== null && proto !== undefined; proto = Object.getPrototypeOf(proto)) {
    if ((proto as { constructor?: { name?: string } }).constructor?.name === "ErrorReply") return true;
  }
  return false;
}

/** Map low-level driver failures onto StorageError. Never includes credentials. */
export function toStorageError(error: unknown, context: string, endpoint: string): StorageError {
  if (error instanceof StorageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/unique constraint violation/i.test(message)) {
    return new StorageError("ingest_conflict", "A record with the same unique key already exists", { cause: error });
  }
  if (isServerReplyError(error)) {
    // The server answered: the graph rejected the query. That is a defect or an incompatible schema, not an outage.
    return new StorageError("internal_error", `FalkorDB rejected the query while ${context}: ${message}`, { cause: error });
  }
  return new StorageError("storage_unavailable", `FalkorDB at ${endpoint} is unreachable while ${context}: ${message}`, {
    cause: error,
    outcomeCertainty: "unknown",
  });
}

/**
 * Thin wrapper over the official `falkordb` client bound to one graph. All Cypher in the
 * project goes through `query`/`roQuery` with parameters; callers never interpolate values.
 */
export class GraphClient {
  readonly graphName: string;
  readonly #db: FalkorDB;
  readonly #graph: Graph;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  #closed = false;

  private constructor(db: FalkorDB, graphName: string, endpoint: string, timeoutMs: number) {
    this.#db = db;
    this.#graph = db.selectGraph(graphName);
    this.graphName = graphName;
    this.#endpoint = endpoint;
    this.#timeoutMs = timeoutMs;
  }

  static async connect(options: GraphClientOptions): Promise<GraphClient> {
    const endpoint = describeEndpoint(options.url);
    const timeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    // `disableOfflineQueue` is a node-redis option that the falkordb typings omit. Without it a
    // write issued during an outage would be queued and applied after reconnect, after the caller
    // was already told it failed. Fail fast instead.
    let connected = false;
    const driverOptions = {
      url: options.url,
      ...(options.username ? { username: options.username } : {}),
      ...(options.password ? { password: options.password } : {}),
      disableOfflineQueue: true,
      socket: {
        connectTimeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        reconnectStrategy: (retries: number) => !connected && options.maxReconnectAttempts !== undefined && retries >= options.maxReconnectAttempts
          ? false : Math.min(250 * 2 ** retries, 5_000),
      },
    } as unknown as FalkorDBOptions;
    let db: FalkorDB | undefined;
    try {
      db = await FalkorDB.connect(driverOptions);
      db.on("error", () => {
        // Connection errors surface on the next query as storage_unavailable; swallow the event so it cannot crash the process.
      });
      const client = new GraphClient(db, options.graph, endpoint, timeoutMs);
      await client.ping();
      connected = true;
      return client;
    } catch (error) {
      if (db) await db.close().catch(() => undefined);
      const cause = toStorageError(error, "connecting", endpoint);
      if (cause.code === "storage_unavailable") {
        throw new StorageError(
          "storage_unavailable",
          `Cannot connect to FalkorDB at ${endpoint}. Start it with "docker compose up -d falkordb" or set FALKORDB_URL. Cause: ${cause.message}`,
          { cause: error, outcomeCertainty: "not_executed" },
        );
      }
      throw cause;
    }
  }

  async #withTimeout<T>(work: Promise<T>, context: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StorageError("storage_unavailable", `FalkorDB at ${this.#endpoint} timed out after ${this.#timeoutMs} ms while ${context}`, { outcomeCertainty: "unknown" })),
        this.#timeoutMs,
      );
    });
    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      throw toStorageError(error, context, this.#endpoint);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new StorageError("storage_unavailable", "The FalkorDB client is closed", { outcomeCertainty: "not_executed" });
  }

  /** Run a parameterized Cypher statement (reads or writes) and return rows keyed by the RETURN aliases. */
  async query<T extends Row = Row>(cypher: string, params: QueryParams = {}, context = "running a query"): Promise<T[]> {
    this.#assertOpen();
    const reply = await this.#withTimeout(this.#graph.query<T>(cypher, { params: params as never }), context);
    return reply.data ?? [];
  }

  /** Read-only variant; the server rejects writes. */
  async roQuery<T extends Row = Row>(cypher: string, params: QueryParams = {}, context = "running a read-only query"): Promise<T[]> {
    this.#assertOpen();
    const reply = await this.#withTimeout(this.#graph.roQuery<T>(cypher, { params: params as never }), context);
    return reply.data ?? [];
  }

  /** Verify the server answers. Used at startup and by /healthz; independent of whether the graph key exists yet. */
  async ping(): Promise<void> {
    this.#assertOpen();
    await this.#withTimeout(this.#db.list(), "checking connectivity");
  }

  /** Create a range index. Succeeds silently when it already exists. */
  async createRangeIndex(label: string, property: string): Promise<void> {
    this.#assertOpen();
    await this.#withTimeout(this.#graph.createNodeRangeIndex(label, property), `creating index ${label}.${property}`).catch(ignoreAlreadyExists);
  }

  /** Create a unique constraint (requires the range index first). Succeeds silently when it already exists. */
  async createUniqueConstraint(label: string, property: string): Promise<void> {
    this.#assertOpen();
    await this.#withTimeout(
      this.#graph.constraintCreate(ConstraintType.UNIQUE, EntityType.NODE, label, property),
      `creating unique constraint ${label}.${property}`,
    ).catch(ignoreAlreadyExists);
  }

  /** Delete the whole graph. Intended for tests that own a throwaway graph name. */
  async dropGraph(): Promise<void> {
    this.#assertOpen();
    await this.#withTimeout(this.#graph.delete(), "dropping the graph").catch((error: unknown) => {
      if (error instanceof StorageError && /empty key/i.test(error.message)) return;
      throw error;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#db.close().catch(() => undefined);
  }
}

function ignoreAlreadyExists(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/already indexed|already exists/i.test(message)) return;
  throw error;
}
