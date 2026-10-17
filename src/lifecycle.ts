/**
 * Process lifecycle shared by the HTTP app and the gateway: whether new calls are admitted and
 * which admitted calls have no completion yet. On shutdown the server stops admission and
 * reports the pending calls; it never claims they recovered.
 */
export class Lifecycle {
  #admissionOpen = true;
  readonly #pending = new Set<string>();

  get admissionOpen(): boolean {
    return this.#admissionOpen;
  }

  /** Stop admitting new calls (called first on shutdown). */
  closeAdmission(): void {
    this.#admissionOpen = false;
  }

  /** Register an admitted call. Throws when admission is closed so callers cannot slip a call in during drain. */
  begin(callId: string): void {
    if (!this.#admissionOpen) throw new Error("Admission is closed: the server is shutting down");
    this.#pending.add(callId);
  }

  /** Mark a call as completed (whatever its outcome). */
  end(callId: string): void {
    this.#pending.delete(callId);
  }

  /** Call IDs admitted but not yet completed. */
  pending(): string[] {
    return [...this.#pending].sort();
  }
}
