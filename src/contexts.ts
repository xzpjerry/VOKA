/** Context transformations are independent of the page and Anki transport. */
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function stripFootnotes(text: string) {
  return text.replace(/\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]|[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu, "");
}
export function normalizeSentence(text: string) {
  return stripFootnotes(text)
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
}
export function sentenceAt(text: string, offset: number, length: number) {
  const part = [
    ...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text),
  ].find((p) => offset >= p.index && offset < p.index + p.segment.length);
  if (!part) throw new Error("找不到这句例句");
  const before = stripFootnotes(part.segment.slice(0, offset - part.index));
  const surface = stripFootnotes(text.slice(offset, offset + length));
  const after = stripFootnotes(
    part.segment.slice(offset - part.index + length),
  );
  let clean = before + surface + after;
  let start = before.length,
    end = start + surface.length;
  if (clean.length > 300) {
    let left = Math.max(0, start - Math.floor((298 - surface.length) / 2));
    let right = Math.min(clean.length, left + 298);
    left = Math.max(0, right - 298);
    // Avoid cutting words while keeping the encountered surface intact.
    if (left > 0) while (left < start && /\S/u.test(clean[left - 1])) left++;
    if (right < clean.length)
      while (right > end && /\S/u.test(clean[right])) right--;
    const prefix = left > 0 ? "…" : "",
      suffix = right < clean.length ? "…" : "";
    clean = prefix + clean.slice(left, right) + suffix;
    start = start - left + prefix.length;
    end = start + surface.length;
  }
  if (
    [
      ...new Intl.Segmenter("en", { granularity: "word" }).segment(clean),
    ].filter((p) => p.isWordLike).length < 3
  )
    throw new Error("这句太短，换一句吧");
  const html =
    escapeHtml(clean.slice(0, start)) +
    "<b>" +
    escapeHtml(clean.slice(start, end)) +
    "</b>" +
    escapeHtml(clean.slice(end));
  return { text: clean.trim(), html: html.trim() };
}
export async function sentenceHash(content: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export type Context = {
  html: string;
  text: string;
  source: string;
  hash: string;
};
export type ContextState = {
  contexts: Context[];
  pin?: string;
  meta: Record<string, any>;
};
export async function contextState(
  fields: Record<string, string>,
  plain: (html: string) => string,
): Promise<ContextState> {
  let meta: Record<string, any> = {};
  try {
    const value = JSON.parse(fields.VokaMeta || "{}");
    if (value && typeof value === "object" && !Array.isArray(value))
      meta = value;
  } catch {
    /* retain readable contexts even with invalid metadata */
  }
  const contexts: Context[] = [];
  for (let i = 1; i <= 3; i++)
    if (fields["Context" + i]) {
      const html = fields["Context" + i];
      contexts.push({
        html,
        text: plain(html),
        source: fields["Source" + i] || "",
        hash: await sentenceHash(html),
      });
    }
  const pin = contexts.some((c) => c.hash === meta.pinnedContext)
    ? (meta.pinnedContext as string)
    : undefined;
  const order: string[] = Array.isArray(meta.contextOrder)
    ? meta.contextOrder
    : [];
  // Unknown hashes represent Anki edits; keep them, using their current slot as fallback.
  contexts.sort((a, b) => {
    const ai = order.indexOf(a.hash),
      bi = order.indexOf(b.hash);
    return (ai < 0 ? -1 : ai) - (bi < 0 ? -1 : bi);
  });
  return { contexts, pin, meta };
}
export function orderedContexts(state: ContextState) {
  return [...state.contexts].sort(
    (a, b) => Number(b.hash === state.pin) - Number(a.hash === state.pin),
  );
}
export function defaultReplacement(state: ContextState) {
  return [...state.contexts].reverse().find((c) => c.hash !== state.pin)?.hash;
}
export function addContext(
  state: ContextState,
  context: Context,
  replace?: string,
): ContextState {
  if (
    state.contexts.some(
      (c) => normalizeSentence(c.text) === normalizeSentence(context.text),
    )
  )
    throw new Error("这句已保存过");
  if (state.contexts.length === 3) {
    if (!replace || !state.contexts.some((c) => c.hash === replace))
      throw new Error("替换一条…");
    if (replace === state.pin) throw new Error("请先取消置顶");
  } else if (replace) throw new Error("例句已变更，请重新选择");
  return {
    ...state,
    contexts: [context, ...state.contexts.filter((c) => c.hash !== replace)],
  };
}
export function togglePin(state: ContextState, hash: string): ContextState {
  if (!state.contexts.some((c) => c.hash === hash))
    throw new Error("例句已变更，请重新选择");
  return { ...state, pin: state.pin === hash ? undefined : hash };
}
export function contextFields(state: ContextState) {
  const fields: Record<string, string> = {};
  const ordered = orderedContexts(state);
  for (let i = 1; i <= 3; i++) {
    fields["Context" + i] = ordered[i - 1]?.html || "";
    fields["Source" + i] = ordered[i - 1]?.source || "";
  }
  fields.VokaMeta = JSON.stringify({
    ...state.meta,
    pinnedContext: state.pin ?? null,
    contextOrder: state.contexts.map((c) => c.hash),
  });
  return fields;
}
export function contextSource(
  url: string,
  title: string,
  date: string,
  fullUrl = false,
) {
  return `${fullUrl ? url : new URL(url).hostname} · ${title} · ${date}`;
}
