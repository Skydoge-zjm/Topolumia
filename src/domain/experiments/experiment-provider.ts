import { AppError } from "../../lib/errors.js";

export const CAPABILITY_STATUS = Object.freeze({
  SUPPORTED: "supported",
  PARTIAL: "partial",
  UNAVAILABLE: "unavailable",
});

const VALID_STATUSES = new Set(Object.values(CAPABILITY_STATUS));

/**
 * Converts the legacy boolean capability profile into a richer, explainable
 * capability map while keeping boolean flags available to old consumers.
 */
export function normalizeCapabilityProfile(profile = {}, explicitDetails = null) {
  const value = profile && typeof profile === "object" ? profile : {};
  const declaredDetails = explicitDetails && typeof explicitDetails === "object"
    ? explicitDetails
    : (value.details && typeof value.details === "object" ? value.details : {});
  const keys = new Set([
    ...Object.keys(value).filter((key) => key !== "details"),
    ...Object.keys(declaredDetails),
  ]);
  const flags = {};
  const details = {};
  for (const key of keys) {
    const raw = declaredDetails[key] ?? value[key];
    const detail = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const rawStatus = detail.status ?? (typeof raw === "boolean" ? (raw ? CAPABILITY_STATUS.SUPPORTED : CAPABILITY_STATUS.UNAVAILABLE) : null);
    const status = VALID_STATUSES.has(rawStatus) ? rawStatus : CAPABILITY_STATUS.UNAVAILABLE;
    flags[key] = status !== CAPABILITY_STATUS.UNAVAILABLE;
    details[key] = {
      ...detail,
      status,
      ...(status === CAPABILITY_STATUS.UNAVAILABLE && !detail.reason ? { reason: "not declared by provider" } : {}),
    };
  }
  return { flags, details };
}

export function capabilityProfileWithDetails(profile = {}, explicitDetails = null) {
  const normalized = normalizeCapabilityProfile(profile, explicitDetails);
  return {
    capabilityProfile: normalized.flags,
    capabilities: normalized.details,
  };
}

/** Merge per-run capability maps for a multi-run Agent context. */
export function mergeCapabilityProfiles(profiles = []) {
  const normalized = profiles.map((profile) => normalizeCapabilityProfile(profile?.capabilityProfile ?? profile, profile?.capabilityDetails ?? profile?.capabilities));
  const keys = new Set(normalized.flatMap((item) => Object.keys(item.details)));
  const details = {};
  for (const key of keys) {
    const entries = normalized.map((item) => item.details[key] ?? {
      status: CAPABILITY_STATUS.UNAVAILABLE,
      reason: "capability not declared by provider",
    });
    const statuses = entries.map((entry) => entry.status);
    let status = CAPABILITY_STATUS.UNAVAILABLE;
    if (statuses.length && statuses.every((item) => item === CAPABILITY_STATUS.SUPPORTED)) status = CAPABILITY_STATUS.SUPPORTED;
    else if (statuses.some((item) => item === CAPABILITY_STATUS.SUPPORTED || item === CAPABILITY_STATUS.PARTIAL)) status = CAPABILITY_STATUS.PARTIAL;
    const reasons = [...new Set(entries.map((entry) => entry.reason).filter(Boolean))];
    details[key] = {
      status,
      ...(reasons.length ? { reasons } : {}),
      ...(entries.some((entry) => Array.isArray(entry.formats))
        ? { formats: [...new Set(entries.flatMap((entry) => entry.formats ?? []))] }
        : {}),
    };
  }
  const flags = Object.fromEntries(Object.entries(details).map(([key, detail]) => [key, detail.status !== CAPABILITY_STATUS.UNAVAILABLE]));
  return { flags, details };
}

export function assertExperimentProvider(adapter, name = "unknown") {
  const required = ["descriptor", "snapshot", "listRuns", "getRun", "getSeries"];
  const missing = required.filter((method) => typeof adapter?.[method] !== "function");
  if (missing.length) {
    throw new AppError("EXPERIMENT_PROVIDER_CONTRACT_INVALID", `实验适配器 ${name} 缺少必要方法。`, {
      status: 500,
      detail: { provider: name, missing },
    });
  }
  return adapter;
}

export function providerSourceStatus(snapshot, fallback = "ready") {
  if (!snapshot || typeof snapshot !== "object") return fallback;
  if (snapshot.sourceStatus) return snapshot.sourceStatus;
  if (snapshot.mode === "unavailable") return "unavailable";
  if (snapshot.degradedReason) return "degraded";
  return fallback;
}

export function aggregateSourceStatus(statuses = []) {
  const list = statuses.filter(Boolean);
  if (!list.length || list.every((status) => status === "unavailable")) return "unavailable";
  if (list.some((status) => ["partial", "degraded", "unavailable"].includes(status))) return "partial";
  return "ready";
}
