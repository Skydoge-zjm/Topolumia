import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResearchMcpServer } from "./research-server.js";

const env = Object.fromEntries(
  ["TOPOLUMIA_URL", "TOPOLUMIA_PROJECT_ID", "TOPOLUMIA_SESSION", "TOPOLUMIA_TRANSFER_ROOT"].map((key) => [
    key,
    process.env[key] ?? "",
  ]),
);
if (["TOPOLUMIA_URL", "TOPOLUMIA_PROJECT_ID", "TOPOLUMIA_SESSION"].some(key => !env[key])) {
  process.stderr.write(
    "Research MCP requires an authenticated project binding.\n",
  );
  process.exitCode = 1;
} else {
  const app = new ResearchMcpServer({ env, cwd: process.cwd() });
  const close = () => {
    void app.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
  try {
    await app.connect(new StdioServerTransport());
  } catch {
    process.stderr.write(
      "Research MCP initialization failed; verify the session, permissions and bundled CLI.\n",
    );
    await app.close();
    process.exitCode = 1;
  }
}
