import type { RouteContext } from "../route-context.js";
import { AppError } from "../../lib/errors.js";
import { readJsonObject, sendJson } from "../../lib/http.js";

import { handleSshRequest } from "../../ssh/ssh-http.js";

export async function handleEnvironmentsRoutes(context: RouteContext) {
  const {
    request,
    response,
    url,
    pathname,
    requestActor,
    requestRuntime,
    sshConnections,
    sshEnvironments,
  }: RouteContext = context;

  if (!pathname.startsWith("/api/ssh/") && !pathname.startsWith("/api/tools-environment")) return false;
  if (!requestActor.user) throw new AppError("AUTH_REQUIRED", "请先登录。", { status: 401 });
  if (
    await handleSshRequest({
      request,
      response,
      pathname,
      runtime: requestRuntime,
      owner: requestActor.user.id,
      ssh: sshConnections,
      hub: sshEnvironments,
    })
  )
    return true;
  const ownerId = requestActor.user.id;
  const sshId = pathname.startsWith("/api/tools-environment")
    ? request.headers["x-rw-ssh-id"]
    : null;
  if (sshId && (typeof sshId !== "string" || !/^[a-f0-9-]{36}$/.test(sshId)))
    throw new AppError("SSH_CONNECTION_INVALID", "SSH 连接标识无效。", {
      status: 422,
    });
  const environmentCatalog = async () =>
    sshId
      ? sshEnvironments.catalog(requestRuntime, ownerId, sshId)
      : requestRuntime.toolEnvironment.catalog;
  if (pathname === "/api/tools-environment" && request.method === "GET") {
    sendJson(
      response,
      200,
      sshId
        ? await sshEnvironments.inventory(
            requestRuntime,
            ownerId,
            sshId,
          )
        : requestRuntime.toolEnvironment.inventory(),
    );
    return true;
  }
  if (
    pathname === "/api/tools-environment/catalog" &&
    request.method === "GET"
  ) {
    sendJson(response, 200, (await environmentCatalog()).view());
    return true;
  }
  const environmentSourceMatch = pathname.match(
    /^\/api\/tools-environment\/catalog\/sources\/(python|conda|venv)$/,
  );
  if (environmentSourceMatch && request.method === "GET") {
    sendJson(
      response,
      200,
      await (
        await environmentCatalog()
      ).discover(
        environmentSourceMatch[1],
        url.searchParams.get("refresh") === "true",
      ),
    );
    return true;
  }
  if (
    pathname === "/api/tools-environment/catalog/register" &&
    request.method === "POST"
  ) {
    const body = await readJsonObject(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.hasOwn(body, "pythonCommand")
    )
      throw new AppError(
        "ENVIRONMENT_INTERPRETER_INVALID",
        "添加解释器只接受可执行文件路径。",
        { status: 422 },
      );
    sendJson(
      response,
      201,
      await (await environmentCatalog()).register(body.pythonCommand),
    );
    return true;
  }
  const environmentCatalogMatch = pathname.match(
    /^\/api\/tools-environment\/catalog\/environments\/([a-f0-9]{24})(?:\/(check|activate|packages|packages\/refresh))?$/,
  );
  if (environmentCatalogMatch) {
    const [, id, action] = environmentCatalogMatch;
    const catalog = await environmentCatalog();
    if (!action && request.method === "GET") {
      sendJson(response, 200, await catalog.report(id));
      return true;
    }
    if (action === "packages" && request.method === "GET") {
      sendJson(
        response,
        200,
        await catalog.packagePage(id, {
          query: url.searchParams.get("q") ?? "",
          offset: Number(url.searchParams.get("offset") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 50),
        }),
      );
      return true;
    }
    if (
      request.method === "POST" &&
      ["check", "activate", "packages/refresh"].includes(action)
    ) {
      const body = await readJsonObject(request);
      const allowed = action === "check" ? ["componentId", "refresh"] : [];
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !allowed.includes(key)) ||
        (body.componentId !== undefined &&
          typeof body.componentId !== "string") ||
        (body.refresh !== undefined && typeof body.refresh !== "boolean")
      )
        throw new AppError("ENVIRONMENT_ACTION_INVALID", "环境操作参数无效。", {
          status: 422,
        });
      const result =
        action === "check"
          ? await catalog.check(id, body)
          : action === "activate"
            ? await catalog.activate(id)
            : await catalog.refreshPackages(id);
      sendJson(response, action === "activate" ? 200 : 202, result);
      return true;
    }
  }
  if (
    pathname === "/api/tools-environment/conda/environments" &&
    request.method === "GET"
  ) {
    if (sshId) {
      sendJson(
        response,
        200,
        await (await environmentCatalog()).discover("conda"),
      );
      return true;
    }
    try {
      sendJson(
        response,
        200,
        await requestRuntime.toolEnvironment.researchEnvironment.condaEnvironments(),
      );
    } catch {
      throw new AppError(
        "CONDA_UNAVAILABLE",
        "Conda 环境列表读取失败，请检查 Conda 可执行文件配置。",
        { status: 422 },
      );
    }
    return true;
  }
  if (
    pathname === "/api/tools-environment/python-environment" &&
    request.method === "PATCH"
  ) {
    if (sshId)
      throw new AppError("SSH_USE_CATALOG", "请选择并验证具体的远程环境。", {
        status: 422,
      });
    sendJson(
      response,
      200,
      await requestRuntime.toolEnvironment.selectEnvironment(
        await readJsonObject(request),
      ),
    );
    return true;
  }
  if (
    pathname === "/api/tools-environment/python-environment/check" &&
    request.method === "POST"
  ) {
    if (sshId)
      throw new AppError("SSH_USE_CATALOG", "请检测具体的远程环境。", {
        status: 422,
      });
    const body = await readJsonObject(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => k !== "componentId") ||
      (body.componentId !== undefined && typeof body.componentId !== "string")
    )
      throw new AppError("RESEARCH_CHECK_INVALID", "检测只接受组件标识。", {
        status: 422,
      });
    requestRuntime.toolEnvironment.research.start(body.componentId);
    sendJson(response, 202, requestRuntime.toolEnvironment.inventory());
    return true;
  }
  if (
    pathname === "/api/tools-environment/check" &&
    request.method === "POST"
  ) {
    const body = await readJsonObject(request);
    if (
      body?.toolId !== undefined &&
      (typeof body.toolId !== "string" || !body.toolId.trim())
    )
      throw new AppError("TOOL_CHECK_INVALID", "请指定有效工具。", {
        status: 422,
      });
    if (sshId && !body?.toolId)
      throw new AppError("SSH_USE_CATALOG", "请指定要检测的远程工具。", {
        status: 422,
      });
    sendJson(
      response,
      200,
      sshId
        ? await sshEnvironments.checkTool(
            requestRuntime,
            ownerId,
            sshId,
            body.toolId ?? "",
          )
        : await requestRuntime.toolEnvironment.check(body?.toolId ?? null),
    );
    return true;
  }
  if (
    pathname === "/api/tools-environment/python/inspect" &&
    request.method === "POST"
  ) {
    if (sshId)
      throw new AppError("SSH_USE_CATALOG", "请选择具体的远程环境进行检测。", {
        status: 422,
      });
    const body = await readJsonObject(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length
    )
      throw new AppError(
        "PYTHON_INSPECTION_INVALID",
        "Python 环境检测不接受自定义命令或脚本。",
        { status: 422 },
      );
    sendJson(
      response,
      200,
      await requestRuntime.toolEnvironment.inspectPython(),
    );
    return true;
  }
  const toolConfigurationMatch = pathname.match(
    /^\/api\/tools-environment\/tools\/([^/]+)$/,
  );
  if (toolConfigurationMatch && request.method === "PATCH") {
    const body = await readJsonObject(request);
    sendJson(
      response,
      200,
      sshId
        ? await sshEnvironments.configureTool(
            requestRuntime,
            ownerId,
            sshId,
            toolConfigurationMatch[1],
            body,
          )
        : await requestRuntime.toolEnvironment.configure(
            toolConfigurationMatch[1],
            body,
          ),
    );
    return true;
  }

  return false;
}
