import { safeUrl } from "@/features/research/model";

export const cleanText = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function paperIdentifierUrl(kind: "doi" | "arxiv", value: string) {
  const identifier = cleanText(value).replace(kind === "doi" ? /^doi:\s*/i : /^arxiv:\s*/i, "").trim();
  if (!identifier) return null;
  const base = kind === "doi" ? "https://doi.org/" : "https://arxiv.org/abs/";
  return safeUrl(/^[a-z][a-z\d+.-]*:/i.test(identifier) ? identifier : base + identifier);
}

/** Stored identifiers are often bare ("10.1000/x", "2502.14321v3"); turn them into resolvable links. */
export function paperIdentifiers(core: Record<string, any>) {
  const doi = cleanText(core.identifiers?.doi), arxiv = cleanText(core.identifiers?.arxiv);
  return [
    ...(doi ? [{ key: "doi", label: "DOI", href: paperIdentifierUrl("doi", doi) }] : []),
    ...(arxiv ? [{ key: "arxiv", label: "arXiv", href: paperIdentifierUrl("arxiv", arxiv) }] : []),
  ];
}

/** Authors are stored verbatim from the source; trim separators humans type by habit. */
export function paperAuthorNames(core: Record<string, any>) {
  return (Array.isArray(core.authors) ? core.authors : []).map(cleanText).filter(Boolean).map(author => author.replace(/[;,]\s*$/, ""));
}

export function paperAuthors(core: Record<string, any>, en: boolean) {
  const authors = paperAuthorNames(core);
  if (!authors.length) return "";
  const shown = authors.slice(0, 6).join(en ? ", " : "、");
  return authors.length > 6 ? shown + (en ? ` et al. (${authors.length})` : ` 等 ${authors.length} 人`) : shown;
}

export function paperLinks(core: Record<string, any>) {
  return (Array.isArray(core.urls) ? core.urls : []).map(safeUrl).filter((url): url is string => Boolean(url));
}
