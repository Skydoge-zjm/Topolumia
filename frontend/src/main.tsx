import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";
import { App } from "./app/App";
import "./app/app.css";
import "./features/agents/motion/agent-motion.css";
import "./features/agents/approvals/agent-approval.css";
import "katex/dist/katex.min.css";
import "./features/agents/agent-workbench.css";
import "./shared/styles/typography.css";
import "./features/research/ResearchWorkspace.css";
import "./shared/styles/responsive.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
