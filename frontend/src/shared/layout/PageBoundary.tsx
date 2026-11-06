import { Component, useEffect } from "react";
import type { ReactNode } from "react";

const moduleFailure = /Failed to fetch dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading chunk .+ failed/i;
const retryKey = "topolumia:page-module-retry";

export class PageBoundary extends Component<{ children: ReactNode; en: boolean }, { failed: boolean; message: string }> {
  state = { failed: false, message: "" };
  static getDerivedStateFromError(error: unknown) { return { failed: true, message: error instanceof Error ? error.message : String(error) }; }
  private recoverAfterUpdate = () => {
    if (this.state.failed) window.location.reload();
  };
  componentDidMount() { import.meta.hot?.on("vite:afterUpdate", this.recoverAfterUpdate); }
  componentWillUnmount() { import.meta.hot?.off("vite:afterUpdate", this.recoverAfterUpdate); }
  componentDidCatch(error: Error) {
    if (!moduleFailure.test(error.message)) return;
    const signature = window.location.href;
    try {
      if (sessionStorage.getItem(retryKey) === signature) return;
      sessionStorage.setItem(retryKey, signature);
    } catch { return; }
    window.location.reload();
  }
  render() {
    if (this.state.failed) return <section className="research-workspace" role="alert"><h1>{this.props.en ? "Unable to load this page" : "页面加载失败"}</h1>{import.meta.env.DEV && <p style={{ overflowWrap: "anywhere" }}>{this.state.message}</p>}<button className="button" onClick={() => window.location.reload()}>{this.props.en ? "Reload page" : "重新加载页面"}</button></section>;
    return this.props.children;
  }
}

/** Commit only after the route's Suspense content has loaded successfully. */
export function PageReady({ children }: { children: ReactNode }) {
  useEffect(() => { try { sessionStorage.removeItem(retryKey); } catch { /* Manual reload remains available. */ } }, []);
  return children;
}
