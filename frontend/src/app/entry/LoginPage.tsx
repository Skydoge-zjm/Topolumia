import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Eye, EyeOff, LoaderCircle } from "lucide-react";

import { api } from "@/shared/lib/api";
import { useUiStore } from "@/shared/state/ui";
import { TopologyIllustration } from "./TopologyIllustration";
import styles from "./entry.module.css";

export function LoginPage({ setupMode = false, onLoggedIn }: { setupMode?: boolean; onLoggedIn: () => void }) {
  const en = useUiStore(state => state.locale) === "en";
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await api(setupMode ? "/api/auth/bootstrap" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ ...(setupMode ? { displayName } : {}), username, password }),
      });
      const me = await api<{ user?: { id?: string } }>("/api/auth/me");
      if (me.user?.id) window.localStorage.setItem("topolumia-actor-id", me.user.id);
      onLoggedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : en ? "Sign-in failed" : "登录失败");
      setPending(false);
    }
  };
  const title = setupMode ? (en ? "Set up the research workbench" : "初始化研究工作台") : (en ? "Sign in to the research workbench" : "登录研究工作台");
  return (
    <div className={styles.login}>
      <aside className={styles.loginArt} aria-hidden="true">
        <img className={styles.wordmark} src="/topolumia-wordmark-white-clean.png" alt="" />
        <TopologyIllustration />
      </aside>
      <main className={styles.loginMain}>
        <Link className={styles.back} to="/"><ArrowLeft size={15} aria-hidden="true" />{en ? "Home" : "首页"}</Link>
        <form className={styles.form} onSubmit={submit} aria-busy={pending}>
          <img className={styles.formMark} src="/topolumia-mark.png" alt="Topolumia" />
          <h1>{title}</h1>
          {setupMode && (
            <label className={styles.field}>
              {en ? "Display name" : "显示名称"}
              <input value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" required />
            </label>
          )}
          <label className={styles.field}>
            {en ? "Username" : "用户名"}
            <input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoFocus required />
          </label>
          <div className={styles.field}>
            <label htmlFor="login-password">{en ? "Password" : "密码"}</label>
            <span className={styles.password}>
              <input
                id="login-password"
                type={visible ? "text" : "password"}
                minLength={setupMode ? 12 : undefined}
                autoComplete={setupMode ? "new-password" : "current-password"}
                value={password}
                onChange={event => setPassword(event.target.value)}
                aria-describedby={setupMode ? "password-rule" : undefined}
                required
              />
              <button type="button" onClick={() => setVisible(!visible)} aria-label={en ? "Show characters" : "显示明文"} aria-pressed={visible}>
                {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </span>
          </div>
          {setupMode && <small className={styles.hint} id="password-rule">{en ? "At least 12 characters" : "至少 12 个字符"}</small>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button className={styles.submit} type="submit" disabled={pending}>
            {pending && <LoaderCircle className={styles.spin} size={16} aria-hidden="true" />}
            {setupMode ? (en ? "Create and sign in" : "创建并登录") : (en ? "Sign in" : "登录")}
          </button>
        </form>
      </main>
    </div>
  );
}
