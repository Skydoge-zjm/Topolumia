import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../../vitest-setup";
import { api } from "./api";

describe("frontend API client", () => {
  it("uses the MSW boundary for typed JSON requests", async () => {
    server.use(
      http.get("/api/frontend-test", () => HttpResponse.json({ ok: true })),
    );
    await expect(api<{ ok: boolean }>("/api/frontend-test")).resolves.toEqual({
      ok: true,
    });
  });
});
