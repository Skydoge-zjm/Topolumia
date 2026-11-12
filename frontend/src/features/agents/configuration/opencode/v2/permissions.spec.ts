import { describe, it, expect } from "vitest";
import { openCodeV2PermissionValue, setOpenCodeV2Permission } from "./permissions";

describe("OpenCode 2 permission editing", () => {
  it("updates only the default rule and preserves ordered exceptions and custom fields", () => {
    const value = { model: "lab/reasoner", providers: { lab: { settings: { baseURL: "https://fixture.invalid" } } }, permissions: [
      { action: "*", resource: "*", effect: "ask" }, { action: "shell", resource: "git push *", effect: "deny" }, { action: "external_directory", resource: "*", effect: "ask" },
    ] };
    const next = setOpenCodeV2Permission(value, "allow");
    expect(next.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }, ...value.permissions.slice(1)]);
    expect(next.providers).toEqual(value.providers); expect(value.permissions[0].effect).toBe("ask");
    expect(openCodeV2PermissionValue(next)).toEqual(next.permissions);
  });
  it("clearing the default retains exceptions and keeps V2 array syntax", () => {
    const next = setOpenCodeV2Permission({ permission: "ask", permissions: [{ action: "shell", resource: "rm *", effect: "deny" }] }, undefined);
    expect(next.permission).toBeUndefined(); expect(next.permissions).toEqual([{ action: "shell", resource: "rm *", effect: "deny" }]);
  });
});
