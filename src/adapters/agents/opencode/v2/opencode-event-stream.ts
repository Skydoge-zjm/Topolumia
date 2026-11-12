import type { OpenCodeClient, OpenCodeEvent, SessionEventDurable } from "@opencode/client";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../../../../lib/errors.js";

export type OpenCodeV2Event = OpenCodeEvent | SessionEventDurable;

export class OpenCodeV2EventStream {
  private abort = new AbortController();
  private task?: Promise<void>;
  private seen = new Set<string>();
  private sequence = 0;

  constructor(private client: OpenCodeClient, private sessionID: string,
    private consume: (event: OpenCodeV2Event) => void | Promise<void>, private reconcile: () => Promise<void>,
    private failed: (error: unknown) => void, private reconnecting: () => void) {}

  async start(): Promise<void> {
    let ready!: () => void, fail!: (error: unknown) => void;
    const connected = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    const timeout = setTimeout(() => fail(new AppError("OPENCODE_V2_STREAM_UNAVAILABLE", "无法连接 OpenCode 2 事件流。", { status: 503 })), 15_000);
    this.task = this.run(ready).catch(error => { if (!this.abort.signal.aborted) { fail(error); this.failed(error); } });
    try { await connected; } finally { clearTimeout(timeout); }
  }

  private async accept(event: OpenCodeV2Event): Promise<void> {
    const data = event.data;
    const sessionID = "sessionID" in data ? data.sessionID : event.type === "form.created" ? event.data.form.sessionID : null;
    if (sessionID !== this.sessionID) return;
    if (this.seen.has(event.id)) return;
    await this.consume(event);
    this.seen.add(event.id);
    if (this.seen.size > 20_000) this.seen.delete(this.seen.values().next().value!);
    if ("durable" in event) this.sequence = Math.max(this.sequence, event.durable.seq);
  }

  private async run(ready: () => void): Promise<void> {
    let attempts = 0, reconnect = false;
    while (!this.abort.signal.aborted) {
      const started = Date.now();
      try {
        for await (const event of this.client.event.subscribe({ signal: this.abort.signal })) {
          if (event.type === "server.connected") {
            if (reconnect) {
              for await (const record of this.client.experimental.session.log({ sessionID: this.sessionID, after: this.sequence, follow: false }, { signal: this.abort.signal })) {
                if (record.type !== "log.synced") await this.accept(record);
                else if (record.seq !== undefined) this.sequence = Math.max(this.sequence, record.seq);
              }
              await this.reconcile();
            }
            ready();
          } else await this.accept(event);
        }
      } catch (error) { if (this.abort.signal.aborted) return; if (++attempts > 4) throw error; }
      if (this.abort.signal.aborted) return;
      if (Date.now() - started > 10_000) attempts = 0;
      if (++attempts > 4) throw new AppError("OPENCODE_V2_STREAM_LOST", "OpenCode 2 事件连接持续中断。", { status: 503 });
      reconnect = true; this.reconnecting();
      await delay(Math.min(250 * 2 ** attempts, 4_000), undefined, { signal: this.abort.signal });
    }
  }

  async close(): Promise<void> { this.abort.abort(); await this.task; }
}
