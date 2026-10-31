import {
  CORE_FIELDS,
  DEFAULT_TARGET,
  lookup,
  vokaMeta,
  type Call,
  type Entry,
} from "./import";
import { questionHtml, answerHtml, css } from "../data/template";
import { replaceGlossCss } from "./gloss";
import { normalizeKey } from "../key";
import { testPack, testReadingEntries } from "../data/test-pack";
import {
  addContext,
  contextFields,
  contextSource,
  contextState,
  escapeHtml,
  orderedContexts,
  sentenceHash,
  togglePin,
} from "../contexts";
import type { ReadingSettings } from "../reading";

// In the worker there is no DOM parser. Tags are discarded, never rendered as HTML.
export function plainHtml(html: string) {
  return html
    .replace(/<(?:br\b[^>]*|\/p|\/div)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (all, entity: string) => {
        const named: Record<string, string> = {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
        };
        if (entity[0] !== "#") return named[entity.toLowerCase()] ?? all;
        const code =
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      },
    );
}
export type ContextRequest = {
  key: string;
  action: "read" | "save" | "pin";
  text?: string;
  html?: string;
  replace?: string;
  hash?: string;
  url?: string;
  title?: string;
};
async function readNote(call: Call, key: string) {
  const ids = (await lookup(call, DEFAULT_TARGET, [key])).get(key) || [];
  if (ids.length > 1) throw new Error("同一 Key 有多条笔记，无法写入");
  if (!ids.length) return undefined;
  const result = await call("notes.getMany", { ids });
  if (result.items[0]?.error || !result.items[0]?.result)
    throw new Error("无法读取笔记");
  if (result.items[0].result.fields.Key !== key)
    throw new Error("词条 Key 已变更，请重新选择");
  return result.items[0].result;
}
async function view(note: any) {
  const state = await contextState(note?.fields || {}, plainHtml);
  return {
    exists: !!note,
    fields: note?.fields || {},
    contexts: orderedContexts(state),
    pin: state.pin,
  };
}
/** Each operation re-resolves Key and reads fields; requests never carry cached fields. */
export async function cardContext(
  call: Call,
  request: ContextRequest,
  config: ReadingSettings & { storeFullUrl?: boolean },
) {
  let note = await readNote(call, request.key);
  if (request.action === "read") return view(note);
  if (request.action === "pin" && !note) throw new Error("笔记已不存在");
  let state = await contextState(note?.fields || {}, plainHtml);
  if (request.action === "pin") state = togglePin(state, request.hash || "");
  else {
    const text = request.text || "";
    // Only accept the one safe <b> wrapper emitted by sentenceAt; never accept page HTML.
    const html = request.html || "";
    if (
      html.replace(/<b>|<\/b>/g, "").includes("<") ||
      plainHtml(html) !== text ||
      (html.match(/<b>/g) || []).length !== 1 ||
      (html.match(/<\/b>/g) || []).length !== 1
    )
      throw new Error("无效例句");
    if (
      [
        ...new Intl.Segmenter("en", { granularity: "word" }).segment(text),
      ].filter((p) => p.isWordLike).length < 3
    )
      throw new Error("这句太短，换一句吧");
    if (text.length > 400) throw new Error("例句太长");
    state = addContext(
      state,
      {
        html,
        text,
        hash: await sentenceHash(html),
        source: escapeHtml(
          contextSource(
            request.url!,
            request.title || "",
            new Date().toISOString().slice(0, 10),
            config.storeFullUrl,
          ),
        ),
      },
      request.replace,
    );
  }
  if (!note) {
    const lemma = request.key.slice(3);
    const entry: Entry = [...testPack.entries, ...testReadingEntries].find(
      (e) => normalizeKey(e.lemma) === request.key,
    ) || { lemma, level: "", Reading: "", GlossNative: "", GlossTarget: "" };
    const deck = "VOKA::English::" + (entry.level || "Unleveled");
    if (
      !(await call("noteTypes.list")).some(
        (t: any) => t.name === DEFAULT_TARGET.noteType,
      )
    )
      await call(
        "noteTypes.create",
        {
          name: DEFAULT_TARGET.noteType,
          fields: CORE_FIELDS.map((name) => ({ name })),
          templates: [{ name: "词卡", questionHtml, answerHtml }],
          css: replaceGlossCss(
            css,
            config.nativeLanguage === "en" ? "target" : config.glossLanguage,
          ),
          sortField: "Word",
        },
        true,
      );
    const type = await call("noteTypes.get", {
      noteType: { name: DEFAULT_TARGET.noteType },
    });
    if (
      JSON.stringify(type.fields.map((f: any) => f.name)) !==
      JSON.stringify(CORE_FIELDS)
    )
      throw new Error("笔记类型字段不匹配");
    if (!(await call("decks.list")).some((d: any) => d.name === deck))
      await call("decks.create", { name: deck }, true);
    const actual = {
      ...entry,
      GlossNative: config.nativeLanguage === "en" ? "" : entry.GlossNative,
    };
    state.meta = JSON.parse(await vokaMeta(actual));
    const fields: Record<string, string> = {
      ...Object.fromEntries(CORE_FIELDS.map((f) => [f, ""])),
      Key: request.key,
      Word: entry.lemma,
      Reading: entry.Reading,
      GlossNative: actual.GlossNative,
      GlossTarget: entry.GlossTarget,
      ...contextFields(state),
    };
    const notes = [
      {
        noteType: { name: DEFAULT_TARGET.noteType },
        deck: { name: deck },
        tags: ["voka", ...(entry.level ? ["voka::level::" + entry.level] : [])],
        fields,
      },
    ];
    const validation = await call("notes.validateMany", { notes });
    if (validation.items[0]?.result?.valid !== true)
      throw new Error("笔记无法加入：" + JSON.stringify(validation.items[0]));
    let failure: unknown;
    try {
      const result = await call(
        "notes.createMany",
        { notes, atomic: false },
        true,
      );
      if (result.items[0]?.error) failure = result.items[0].error;
    } catch (error) {
      failure = error;
    }
    note = await readNote(call, request.key);
    if (!note || note.fields.Context1 !== fields.Context1)
      throw new Error("写入未确认，未重发：" + String(failure || "回读不匹配"));
    return view(note);
  }
  // No awaits or ancillary requests between this fresh read/merge and update.
  const desired = contextFields(state),
    changed = Object.fromEntries(
      Object.entries(desired).filter(([k, v]) => note.fields[k] !== v),
    );
  let failure: unknown;
  try {
    if (Object.keys(changed).length)
      await call(
        "notes.update",
        { id: note.id, patch: { fields: changed } },
        true,
      );
  } catch (error) {
    failure = error;
  }
  const current = await readNote(call, request.key);
  if (
    !current ||
    Object.entries(changed).some(([k, v]) => current.fields[k] !== v)
  )
    throw new Error("写入未确认，未重发：" + String(failure || "回读不匹配"));
  return view(current);
}
