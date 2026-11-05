export class AgentSessionPersistence {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private store,
    private onStatus: (session, status: string, error?: string) => void,
  ) {}
  schedule(session) {
    if (!this.store || this.closed || this.timers.has(session.id)) return;
    // Throttle checkpoints; a continuous stream cannot postpone this deadline.
    const timer = setTimeout(() => {
      this.timers.delete(session.id);
      void this.save(session).catch(() => {});
    }, 500);
    timer.unref?.();
    this.timers.set(session.id, timer);
  }
  async save(session): Promise<void> {
    if (!this.store || this.closed) return;
    clearTimeout(this.timers.get(session.id));
    this.timers.delete(session.id);
    const previous = this.pending.get(session.id) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        if (this.closed) return;
        this.onStatus(session, "saving");
        try {
          await this.store.upsert(session);
          this.onStatus(session, "persisted");
        } catch (error) {
          this.onStatus(
            session,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      });
    this.pending.set(session.id, task);
    try {
      await task;
    } finally {
      if (this.pending.get(session.id) === task)
        this.pending.delete(session.id);
    }
  }
  async close(sessions) {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.pending.values());
    try {
      await Promise.all(sessions.map((session) => this.save(session)));
    } finally {
      this.closed = true;
      this.store?.close();
    }
  }
}
