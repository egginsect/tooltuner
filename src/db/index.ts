/**
 * Persistence boundary. All Cypher lives in this folder. Callers hold a `GraphClient` and call
 * small explicit functions added here per record kind; they never build query strings.
 * The foundation provides the client, index bootstrap and health probe only.
 */
export { GraphClient, toStorageError, type GraphClientOptions, type ParamValue, type QueryParams, type Row } from "./client.js";
export { GRAPH_SCHEMA_VERSION, INDEX_SPECS, bootstrapSchema, readSchemaVersion, type BootstrapReport, type IndexSpec } from "./schema.js";
