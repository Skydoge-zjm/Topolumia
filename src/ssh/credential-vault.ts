import path from "node:path";
import { spawn } from "node:child_process";
import { bundledRoot, mvpRoot } from "../config.js";
import { access, readFile } from "node:fs/promises";
import { AppError } from "../lib/errors.js";

export class SshCredentialVault {
  get available() {
    return process.platform === "win32";
  }
  async transform(operation, input) {
    if (!this.available)
      throw new AppError(
        "SSH_VAULT_UNAVAILABLE",
        "此服务主机暂未启用系统凭据存储，可使用仅本次连接。",
        { status: 422 },
      );
    let script = path.join(bundledRoot, "scripts", "runtime", "ssh-protect-secret.ps1");
    if (
      !(await access(script).then(
        () => true,
        () => false,
      ))
    )
      script = path.join(mvpRoot, "scripts", "runtime", "ssh-protect-secret.ps1");
    const source = await readFile(script, "utf8");
    return new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `& { ${source} } '${operation}'`,
        ],
        { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] },
      );
      let output = "",
        settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(
          new AppError(
            "SSH_VAULT_FAILED",
            "系统凭据存储操作失败，未保存明文凭据。",
            { status: 503 },
          ),
        );
      };
      const timer = setTimeout(fail, 8000);
      timer.unref?.();
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (output.length > 65536) fail();
      });
      child.once("error", fail);
      child.stdin.on("error", fail);
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) return fail();
        settled = true;
        clearTimeout(timer);
        resolve(output.trim());
      });
      child.stdin.end(input);
    });
  }
  async protect(value) {
    return this.transform("protect", JSON.stringify(value));
  }
  async reveal(value) {
    return value ? JSON.parse(await this.transform("unprotect", value)) : {};
  }
}
