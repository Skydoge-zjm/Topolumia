import { useEffect, useState } from "react";

export type ChartPrefs = { smoothing: number; logScale: boolean; columns: number };
const STORAGE_KEY = "topolumia-chart-view";
const DEFAULTS: ChartPrefs = { smoothing: 0, logScale: false, columns: 0 };

/** How curves are drawn is a reading preference, so it follows the researcher across records. */
export function useChartPrefs(): [ChartPrefs, (patch: Partial<ChartPrefs>) => void] {
  const [prefs, setPrefs] = useState<ChartPrefs>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      return {
        smoothing: typeof saved.smoothing === "number" && saved.smoothing >= 0 && saved.smoothing < 1 ? saved.smoothing : 0,
        logScale: saved.logScale === true,
        columns: [0, 1, 2, 3].includes(saved.columns) ? saved.columns : 0,
      };
    } catch { return DEFAULTS; }
  });
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* Preferences stay for this visit only. */ } }, [prefs]);
  return [prefs, (patch) => setPrefs((current) => ({ ...current, ...patch }))];
}
