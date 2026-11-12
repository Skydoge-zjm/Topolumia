import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

if (process.argv.includes("--version")) console.log("2.2.7");
else {
  const file = process.env.OPENCODE_CONFIG;
  const original = file ? parse(readFileSync(file, "utf8")) : {};
  const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
  const port = Number(process.argv.find(arg => arg.startsWith("--port="))?.slice(7));
  createServer((request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`) { response.writeHead(401).end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/api/info" ? { version: "2.2.7", pid: process.pid, paths: { tmp: process.cwd() }, urls: [] } :
      { file, original, inline, database: process.env.OPENCODE_DB }));
  }).listen(port, "127.0.0.1");
}
