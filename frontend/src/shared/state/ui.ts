import { create } from "zustand";

interface UiState {
  locale: "zh" | "en";
  sidebarCollapsed: boolean;
  sessionRailCollapsed: boolean;
  agentFocus: boolean;
  setLocale: (locale: "zh" | "en") => void;
  toggleSidebar: () => void;
  toggleSessionRail: () => void;
  toggleAgentFocus: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  locale:
    (window.localStorage.getItem("topolumia-locale") as "zh" | "en" | null) ??
    "zh",
  sidebarCollapsed:
    window.localStorage.getItem("topolumia-sidebar-collapsed") === "true",
  sessionRailCollapsed:
    window.localStorage.getItem("topolumia-session-collapsed") === "true",
  agentFocus: window.localStorage.getItem("topolumia-agent-focus") === "true",
  setLocale: (locale) => {
    window.localStorage.setItem("topolumia-locale", locale);
    set({ locale });
  },
  toggleSidebar: () =>
    set((state) => {
      window.localStorage.setItem(
        "topolumia-sidebar-collapsed",
        String(!state.sidebarCollapsed),
      );
      return { sidebarCollapsed: !state.sidebarCollapsed };
    }),
  toggleSessionRail: () =>
    set((state) => {
      window.localStorage.setItem(
        "topolumia-session-collapsed",
        String(!state.sessionRailCollapsed),
      );
      return { sessionRailCollapsed: !state.sessionRailCollapsed };
    }),
  toggleAgentFocus: () =>
    set((state) => {
      window.localStorage.setItem(
        "topolumia-agent-focus",
        String(!state.agentFocus),
      );
      return { agentFocus: !state.agentFocus };
    }),
}));
