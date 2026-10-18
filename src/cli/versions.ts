/** Local owner control helpers. Import only from the owner CLI, never from MCP handlers. */
import { HumanDecision, FlywheelError, newId, provenanceOf, COMPLETE, type HumanDecision as DecisionRecord } from "../contracts.js";
import { recordDecision } from "../db/registry.js";
import type { GraphClient } from "../db/client.js";

export interface OwnerDecisionContext {
  /** Taken from the trusted local owner configuration, never an MCP principal or args. */
  owner_id: string;
  subject: string;
}
export interface VersionDecisionInput {
  application: string;
  selected_version_id: string;
  expected_current_version_id: string | null;
  receipt: Record<string, unknown>;
}

function makeDecision(owner: OwnerDecisionContext, input: Omit<DecisionRecord, "schema_version" | "owner_id" | "created_at" | "provenance" | "completeness" | "decision_id">): DecisionRecord {
  if (!owner.owner_id || !owner.subject) throw new FlywheelError("forbidden", "A trusted local owner identity is required.");
  return HumanDecision.parse({ ...input, schema_version: 1, owner_id: owner.owner_id, decision_id: newId("decision"),
    created_at: new Date().toISOString(), provenance: { ...provenanceOf("owner_cli", null), subject: owner.subject }, completeness: COMPLETE });
}

export function activateVersion(db: GraphClient, owner: OwnerDecisionContext, input: VersionDecisionInput): Promise<DecisionRecord> {
  return recordDecision(db, makeDecision(owner, { ...input, kind: "activate", source: null }));
}

export function rollbackVersion(db: GraphClient, owner: OwnerDecisionContext, input: VersionDecisionInput): Promise<DecisionRecord> {
  return recordDecision(db, makeDecision(owner, { ...input, kind: "rollback", source: null }));
}

/** Records an already obtained merge receipt; performs no Git or hosting mutation and never activates. */
export function recordMerge(db: GraphClient, owner: OwnerDecisionContext, input: {
  application: string;
  source: NonNullable<DecisionRecord["source"]>;
  selected_version_id: string | null;
  expected_current_version_id: string | null;
  receipt: Record<string, unknown>;
}): Promise<DecisionRecord> {
  return recordDecision(db, makeDecision(owner, { ...input, kind: "merge" }));
}
