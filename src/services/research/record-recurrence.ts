import { AppError } from "../../lib/errors.js";
import type { ResearchSeries } from "../../domain/research/types.js";
export function requireTimezone(timezone:string) {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { throw new AppError("RECORD_TIMEZONE_INVALID", "请选择有效的 IANA 时区。", { status: 422 }); }
}
function wallParts(date:Date, timezone:string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
}
export function localInstant(date:string, time:string, timezone:string) {
  requireTimezone(timezone);
  const [y, m, d] = date.split("-").map(Number), [h, minute] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, minute);
  let instant = wall;
  for (let i = 0; i < 4; i++) {
    const p = wallParts(new Date(instant), timezone);
    instant += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  const p = wallParts(new Date(instant), timezone);
  if (p.year !== y || p.month !== m || p.day !== d || p.hour !== h || p.minute !== minute)
    throw new AppError("RECORD_LOCAL_TIME_INVALID", "该当地时间因夏令时转换而不存在，请修改时间。", { status: 422 });
  return new Date(instant).toISOString();
}
export function seriesOccurrence(series:Pick<ResearchSeries,"startDate"|"frequency"|"interval"|"localTime"|"timezone">, index:number) {
  const [year, month, day] = series.startDate.split("-").map(Number);
  let date;
  if (series.frequency === "monthly") {
    const first = new Date(Date.UTC(year, month - 1 + index * series.interval, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(day, last)); date = first.toISOString().slice(0, 10);
  } else date = new Date(Date.UTC(year, month - 1, day + index * 7 * series.interval)).toISOString().slice(0, 10);
  return { date, scheduledAt: localInstant(date, series.localTime, series.timezone) };
}
