import { useState } from "react";

import { ShieldCheck } from "lucide-react";
import { api } from "@/shared/lib/api";

import { type SshChallenge } from "@/features/environments/ssh/ssh";
import styles from "./SshEnvironmentSelector.module.css";
import { endpoint, message } from "./presentation";

export function LoginChallenge({
  challenge,
  project,
  connection,
  en,
  onUpdate,
  onCancel,
}: {
  challenge: SshChallenge;
  project: string;
  connection: string;
  en: boolean;
  onUpdate: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<string[]>(
    challenge.prompts.map(() => ""),
  );
  const [verified, setVerified] = useState(false),
    [remember, setRemember] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const hostKey = challenge.kind === "host-key";
  return (
    <form
      className={styles.form}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api(endpoint(connection, "respond"), {
            method: "POST",
            headers: { "x-rw-project-id": project },
            body: JSON.stringify({
              challengeId: challenge.id,
              ...(hostKey ? { trust: true, verified } : { values, remember }),
            }),
          });
          setValues(challenge.prompts.map(() => ""));
          onUpdate();
        } catch (err) {
          setError(message(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>
        {hostKey
          ? challenge.changed
            ? en
              ? "Host key changed"
              : "主机指纹已变化"
            : en
              ? "Verify this host"
              : "验证远程主机"
          : en
            ? challenge.kind === "passphrase"
              ? "Unlock private key"
              : "SSH authentication"
            : challenge.title}
      </h3>
      <p className={styles.hint}>
        {challenge.user}@{challenge.host}:{challenge.port}
      </p>
      {hostKey ? (
        <>
          <p className={styles.hint}>
            {challenge.changed
              ? en
                ? "Verify the new fingerprint with your server administrator before updating trust."
                : "请通过可信渠道核对新指纹，再更新此连接的信任记录。"
              : en
                ? "Compare this fingerprint with your server before trusting it."
                : "请核对服务器指纹，确认后会保存到此账号的连接记录。"}
          </p>
          <div className={styles.trust}>
            <ShieldCheck size={22} aria-hidden />
            <strong>{en ? "Host fingerprint" : "主机指纹"}</strong>
            <dl>
              <dt>SHA256</dt>
              <dd>{challenge.fingerprint}</dd>
              {challenge.previousFingerprints?.length ? (
                <>
                  <dt>{en ? "Previous" : "原记录"}</dt>
                  <dd>{challenge.previousFingerprints.join("\n")}</dd>
                </>
              ) : null}
            </dl>
          </div>
          {challenge.changed && (
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
              />
              {en
                ? "I verified the changed fingerprint through a trusted channel"
                : "我已通过可信渠道核对变更后的主机指纹"}
            </label>
          )}
        </>
      ) : (
        <>
          {challenge.instructions && (
            <p className={styles.hint}>{challenge.instructions}</p>
          )}
          {challenge.prompts.map((prompt, i) => (
            <label key={i}>
              {challenge.kind === "password"
                ? en
                  ? "Password"
                  : "密码"
                : prompt.label}
              <input
                autoFocus={i === 0}
                required
                type={prompt.secret ? "password" : "text"}
                value={values[i] ?? ""}
                autoComplete={
                  challenge.kind === "password" ? "current-password" : "off"
                }
                maxLength={4096}
                onChange={(e) =>
                  setValues((p) =>
                    p.map((value, j) => (i === j ? e.target.value : value)),
                  )
                }
              />
            </label>
          ))}
          {challenge.canRemember ? (
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              {en
                ? "Remember with Windows credential encryption"
                : "使用 Windows 账号加密保存凭据"}
            </label>
          ) : null}
          <small>
            {en
              ? "Credentials are used for this connection unless you explicitly remember them. Verification codes are never saved."
              : "默认仅用于本次连接；验证码和交互认证内容不保存。"}
          </small>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button
          className="button primary"
          disabled={busy || Boolean(hostKey && challenge.changed && !verified)}
        >
          {busy
            ? en
              ? "Submitting…"
              : "提交中…"
            : hostKey
              ? en
                ? "Trust and continue"
                : "信任并继续"
              : en
                ? "Continue"
                : "继续登录"}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          {en ? "Cancel connection" : "取消连接"}
        </button>
      </div>
    </form>
  );
}
