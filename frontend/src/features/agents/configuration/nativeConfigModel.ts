import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";
import { parse as jsonParse, printParseErrorCode } from "jsonc-parser";
export type NativeConfigDocument = {
  provider: string;
  filename: string;
  format: string;
  path: string;
  content: string;
  revision: string;
  updatedAt: string;
  valid: boolean;
  validation: {
    message: string;
    detail?: { line?: number; column?: number };
  } | null;
  schema: Record<string, any>;
  schemaUrl: string;
  docsUrl: string;
};
export function parseConfig(
  provider: string,
  source: string,
): Record<string, any> {
  let value;
  if (provider === "codex") value = tomlParse(source);
  else {
    const errors: any[] = [];
    value = jsonParse(source, errors, {
      allowTrailingComma: provider === "opencode",
      disallowComments: provider !== "opencode",
      allowEmptyContent: false,
    });
    if (errors.length) {
      const error = errors[0],
        lines = source.slice(0, error.offset).split(/\r?\n/);
      throw new Error(
        `${printParseErrorCode(error.error)} · ${lines.length}:${lines.at(-1)!.length + 1}`,
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("配置根节点必须为对象 / Configuration must be an object");
  return value;
}
export function serializeConfig(provider: string, value: Record<string, any>) {
  return provider === "codex"
    ? tomlStringify(value)
    : JSON.stringify(value, null, 2) + "\n";
}
export function setConfigPath(
  value: Record<string, any>,
  path: string[],
  item: any,
) {
  const result = structuredClone(value);
  let target = result;
  for (const key of path.slice(0, -1)) {
    target[key] = { ...target[key] };
    target = target[key];
  }
  if (item === undefined) delete target[path.at(-1)!];
  else target[path.at(-1)!] = item;
  return result;
}
