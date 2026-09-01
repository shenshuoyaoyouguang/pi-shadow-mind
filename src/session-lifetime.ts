const STALE_CONTEXT_MARKER = "This extension ctx is stale after session replacement or reload";

export class SessionLifetime {
  private active = false;

  activate(): void {
    this.active = true;
  }

  deactivate(): void {
    this.active = false;
  }

  get isActive(): boolean {
    return this.active;
  }

  run(action: () => void): boolean {
    if (!this.active) return false;
    try {
      action();
      return true;
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      // A stale ctx only invalidates the callback that hit it; deactivating
      // here would silence every later write of the replacement session until
      // its own session_start. Only deactivate() (session_shutdown) disables.
      return false;
    }
  }
}

export function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_CONTEXT_MARKER);
}
