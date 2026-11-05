import * as z from "zod/v4";
import { AppError } from "../lib/errors.js";
import { readJson, sendJson } from "../lib/http.js";

const replySchema = z.strictObject({
  challengeId: z.uuid(),
  values: z.array(z.string().max(4096)).max(8).optional(),
  trust: z.boolean().optional(),
  verified: z.boolean().optional(),
  remember: z.boolean().optional(),
});
const empty = async (request) => {
  const body = await readJson(request);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length
  )
    throw new AppError("SSH_REQUEST_INVALID", "此操作不接受额外参数。", {
      status: 422,
    });
};

export async function handleSshRequest({
  request,
  response,
  pathname,
  runtime,
  owner,
  ssh,
  hub,
}) {
  if (!pathname.startsWith("/api/ssh/")) return false;
  if (pathname === "/api/ssh/connections") {
    if (request.method === "GET") {
      sendJson(response, 200, {
        ...(await ssh.list(owner)),
        current: await hub.currentBinding(runtime, owner),
      });
      return true;
    }
    if (request.method === "POST") {
      sendJson(response, 201, await ssh.save(owner, await readJson(request)));
      return true;
    }
  }
  if (pathname === "/api/ssh/aliases" && request.method === "GET") {
    sendJson(response, 200, { aliases: await ssh.aliases() });
    return true;
  }
  if (pathname === "/api/ssh/resolve" && request.method === "POST") {
    const body = z
      .strictObject({ alias: z.string() })
      .safeParse(await readJson(request));
    if (!body.success)
      throw new AppError("SSH_ALIAS_INVALID", "请输入 SSH 配置别名。", {
        status: 422,
      });
    sendJson(response, 200, await ssh.resolve(body.data.alias));
    return true;
  }
  const match = pathname.match(
    /^\/api\/ssh\/connections\/([a-f0-9-]{36})(?:\/(connect|respond|disconnect|forget-credentials|project))?$/,
  );
  if (!match) return false;
  const [, id, action] = match;
  if (!action && request.method === "PATCH") {
    sendJson(response, 200, await ssh.save(owner, await readJson(request), id));
    return true;
  }
  if (!action && request.method === "DELETE") {
    await ssh.remove(owner, id);
    sendJson(response, 200, { removed: true });
    return true;
  }
  if (action === "project") {
    if (request.method === "GET") {
      sendJson(response, 200, await hub.projectSettings(runtime, owner, id));
      return true;
    }
    if (request.method === "PATCH") {
      sendJson(
        response,
        200,
        await hub.updateProject(runtime, owner, id, await readJson(request)),
      );
      return true;
    }
  }
  if (request.method !== "POST") return false;
  if (action === "respond") {
    const body = replySchema.safeParse(await readJson(request));
    if (!body.success)
      throw new AppError("SSH_AUTH_RESPONSE_INVALID", "登录输入格式无效。", {
        status: 422,
      });
    sendJson(response, 200, await ssh.respond(owner, id, body.data));
    return true;
  }
  if (["connect", "disconnect", "forget-credentials"].includes(action)) {
    await empty(request);
    const result =
      action === "connect"
        ? await ssh.connect(owner, id)
        : action === "disconnect"
          ? await ssh.disconnect(owner, id)
          : await ssh.forget(owner, id);
    sendJson(
      response,
      action === "connect" ? 202 : 200,
      result ?? { forgotten: true },
    );
    return true;
  }
  return false;
}
