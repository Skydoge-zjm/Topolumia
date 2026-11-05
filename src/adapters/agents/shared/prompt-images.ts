import { readFile } from "node:fs/promises";

export async function promptImages(content = []) {
  return Promise.all(
    content
      .filter((part) => part.type === "image")
      .map(async (part) => ({
        data: (await readFile(part.path)).toString("base64"),
        mimeType: part.mimeType,
        name: part.name,
      })),
  );
}
