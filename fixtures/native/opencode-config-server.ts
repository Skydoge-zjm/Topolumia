import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
const port = Number(process.argv.find(arg => arg.startsWith("--port="))?.slice(7));
const file = process.env.OPENCODE_CONFIG;
const original = file ? parse(readFileSync(file, "utf8")) : {};
const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
const app = createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(request.url?.startsWith("/global/health") ? { healthy: true } : { ...original, ...inline, fixtureConfigPath: file, fixtureInline: inline }));
});
app.listen(port, "127.0.0.1");
