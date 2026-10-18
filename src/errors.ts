/**
 * Storage-layer errors. Error codes deliberately reuse the names frozen in the shared contract
 * (storage_unavailable, ingest_conflict, internal_error) so the contract owner can map them
 * one-to-one; this file does not depend on the contract.
 */
export type StorageErrorCode = "storage_unavailable" | "ingest_conflict" | "internal_error";

/**
 * Did the operation take effect?
 * - `not_executed`: definitely nothing happened.
 * - `executed`: it ran and the error is the outcome.
 * - `unknown`: it may or may not have happened (for example a timeout during a write).
 */
export type OutcomeCertainty = "not_executed" | "executed" | "unknown";

export interface StorageErrorBody {
  code: StorageErrorCode;
  message: string;
  retryable: boolean;
  outcome_certainty: OutcomeCertainty;
}

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly retryable: boolean;
  readonly outcomeCertainty: OutcomeCertainty;

  constructor(code: StorageErrorCode, message: string, options: { retryable?: boolean; outcomeCertainty?: OutcomeCertainty; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StorageError";
    this.code = code;
    this.retryable = options.retryable ?? code === "storage_unavailable";
    this.outcomeCertainty = options.outcomeCertainty ?? (code === "ingest_conflict" ? "not_executed" : "unknown");
  }

  toBody(): StorageErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable, outcome_certainty: this.outcomeCertainty };
  }
}
