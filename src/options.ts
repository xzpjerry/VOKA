import { readUpgradeKept, clearUpgradeKept } from "./upgrade-kept";
import { settings, check, t } from "./shared";
import { mountUpgrade } from "./upgrade-ui";
import { LEVELS, loadData, type Level } from "./data";
import {
  DEFAULT_DENY_SITES,
  hostMatchesDeny,
  parseDenyList,
  sitePattern,
  type SiteScope,
} from "./site-scope";
import type { Status } from "./background/gateway";
const style = document.createElement("style");
style.textContent = `body{font:16px/1.6 system-ui;color:#24342e;background:#f4f6f2;margin:0}main{max-width:840px;margin:48px auto;padding:0 24px 64px}.brand{color:#56745e;letter-spacing:.08em}h1{font-size:36px}section,fieldset{min-width:0;border:1px solid #dce4db;border-radius:16px;padding:24px;background:white;margin:20px 0}fieldset:disabled{opacity:.45}h2{margin-top:0}label{display:inline-flex;flex-direction:column;gap:6px;margin:8px 16px 12px 0}input,select,button,textarea{font:inherit;padding:9px 12px;border:1px solid #c5d1c6;border-radius:8px}button{cursor:pointer;background:#edf3e9;margin:4px}button:disabled{cursor:default;opacity:.5}.levels{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.levels label{border:1px solid #dce4db;padding:12px;margin:0}.levels label:has(:checked){border-color:#386344;background:#f0f6ec}.scopes label{display:flex;flex-direction:row;align-items:center;gap:8px;margin:6px 0;border:1px solid #dce4db;border-radius:8px;padding:10px 12px}.scopes label:has(:checked){border-color:#386344;background:#f0f6ec}.siteRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #eef1ec}textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,monospace}ol{padding-left:24px}li{padding:8px}li[data-state=bad]{color:#8c352c}li[data-state=wait]{color:#7d847f}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}details{margin:12px 0}progress{width:100%;height:14px}.import-meta{white-space:pre-line;margin:8px 0}[hidden]{display:none!important}@media(max-width:600px){.levels{grid-template-columns:repeat(2,1fr)}}`;
document.head.append(style);
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const upgradeUI = mountUpgrade($("upgradePreview"), $("upgradeStatus"));
const wizard = new URLSearchParams(location.search).has("wizard");
let step = 0;
let connected = false;
let busy = false;
let executing = false;
let previewLevel: Level | undefined;
let previewNew = 0;
let lastRunInterrupted = false;
const initial = await settings();
const port = $<HTMLInputElement>("port");
const apiKey = $<HTMLInputElement>("apiKey");
const nativeLanguage = $<HTMLSelectElement>("nativeLanguage");
const glossLanguage = $<HTMLSelectElement>("glossLanguage");
const importLevel = $<HTMLSelectElement>("importLevel");
const confirmButton = $<HTMLButtonElement>("confirm");
const cancelButton = $<HTMLButtonElement>("cancelImport");
const progress = $<HTMLProgressElement>("importProgress");
const denyListInput = $<HTMLTextAreaElement>("denyListInput");
const siteScopeRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="siteScope"]'),
);
let siteScope: SiteScope = initial.siteScope;
let rememberedSites = initial.rememberedSites;
port.value = String(initial.port);
apiKey.value = initial.apiKey;
nativeLanguage.value = initial.nativeLanguage;
glossLanguage.value = initial.glossLanguage;
denyListInput.value = initial.denyList.join("\n");
for (const radio of siteScopeRadios)
  radio.checked = radio.value === siteScope;
let targetLevel = initial.targetLevel;
function layout() {
  $("title").textContent = wizard ? "欢迎使用 VOKA" : "设置";
  $("steps").hidden = !wizard;
  $("connection").hidden = wizard && step !== 0;
  for (const [id, n] of [
    ["learning", 1],
    ["imports", 2],
  ] as const) {
    $(id).hidden = wizard && step !== n;
    $<HTMLFieldSetElement>(id).disabled = !connected;
  }
  $<HTMLFieldSetElement>("learning").disabled = !connected || busy;
  $("preview").toggleAttribute("disabled", !connected || busy);
  $("importLevel").toggleAttribute("disabled", !connected || busy);
  confirmButton.toggleAttribute(
    "disabled",
    !connected || busy || !previewLevel || previewNew === 0,
  );
  cancelButton.hidden = !(busy && executing);
  cancelButton.disabled = false;
  const denylist = $<HTMLFieldSetElement>("denylist");
  denylist.hidden = wizard;
  denylist.disabled = !connected || busy;
  const about = document.getElementById("about");
  if (about) {
    about.inert = !connected;
    about.style.opacity = connected ? "1" : ".45";
  }
  $("updates").hidden = wizard;
  $<HTMLFieldSetElement>("updates").disabled = !connected;
  for (const id of [
    "nextConnection",
    "nextLearning",
    "backConnection",
    "wizardFinish",
  ])
    $(id).hidden = !wizard;
  $<HTMLButtonElement>("nextConnection").disabled = !connected;
}
function invalidate() {
  previewLevel = undefined;
  previewNew = 0;
  lastRunInterrupted = false;
  confirmButton.textContent = "确认导入";
  confirmButton.toggleAttribute("disabled", true);
  for (const id of [
    "importTarget",
    "importCounts",
    "importConflicts",
    "importSource",
    "importProgressText",
  ])
    $(id).textContent = "";
  progress.hidden = true;
  progress.value = 0;
  $("importStatus").textContent = "";
}
function diagnostics(status: Status) {
  const failure = {
    unreachable: 0,
    "not-new-ankiconnect": 1,
    forbidden: 2,
    auth: 3,
    ok: 4,
  }[status];
  const titles = [
    "连接本机 Anki",
    "新版 AnkiConnect · Anki ≥ 26.08",
    "允许 VOKA 访问",
    "API Key",
  ];
  const hints = [
    "连不上。请依次确认：① Anki 已经打开；② 已安装 AnkiConnect（工具 → 插件 → 获取插件，代码 2055492159），装完重启 Anki；③ 如果你改过 AnkiConnect 的端口，在下面填上。",
    "请升级到 Anki ≥ 26.08，并在「工具 → 插件」里更新 AnkiConnect。",
    `AnkiConnect 拒绝了 VOKA 的请求。点「请求访问权限」后，切到 Anki 窗口点「允许」。或在 AnkiConnect 配置的 webCorsOriginList 里加入 ${chrome.runtime.getURL("").replace(/\/$/, "")}。`,
    "请在下面输入正确的 API Key，再点「重新检测」。",
  ];
  $("checks").replaceChildren(
    ...titles.map((title, i) => {
      const li = document.createElement("li");
      li.dataset.state = i < failure ? "ok" : i === failure ? "bad" : "wait";
      li.textContent = `${title} · ${i < failure ? "通过" : i > failure ? "等上一步" : hints[i]}`;
      return li;
    }),
  );
  $("access").hidden = status !== "forbidden";
}
async function refresh() {
  connected = false;
  invalidate();
  layout();
  $<HTMLButtonElement>("retry").disabled = true;
  $("status").textContent = "正在检测…";
  try {
    const status = await check();
    connected = status === "ok";
    diagnostics(status);
    $("status").textContent = connected ? "已连接" : "VOKA 未运行：请检查 Anki";
  } catch {
    diagnostics("unreachable");
    $("status").textContent = "连接检测失败";
  } finally {
    $<HTMLButtonElement>("retry").disabled = false;
    layout();
  }
}
$("connectionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({
    port: Number(port.value),
    apiKey: apiKey.value.trim(),
  });
  await refresh();
});
for (const input of [port, apiKey])
  input.addEventListener("input", () => {
    connected = false;
    invalidate();
    layout();
  });
$("access").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("access");
  button.disabled = true;
  $("accessStatus").textContent =
    "请切到 Anki 窗口点「允许」，然后点「重新检测」。";
  try {
    const result = await chrome.runtime.sendMessage({ type: "request-access" });
    if (result.error) throw new Error(result.error);
    $("accessStatus").textContent =
      "权限请求已返回。请点「重新检测」确认连接。";
  } catch (error) {
    $("accessStatus").textContent =
      `权限请求失败：${error}。可手动修改 webCorsOriginList 后重新检测。`;
  } finally {
    button.disabled = false;
  }
});
function showGloss() {
  $("glossLanguageRow").hidden = nativeLanguage.value === "en";
}
showGloss();
async function saveLearning() {
  try {
    await chrome.storage.local.set({
      nativeLanguage: nativeLanguage.value,
      glossLanguage: glossLanguage.value,
      targetLevel,
      siteScope,
    });
    $("saveStatus").textContent = "已保存";
  } catch {
    $("saveStatus").textContent = "保存失败，请重试";
    throw new Error("保存失败");
  }
}
function siteScopeMessage(text: string) {
  $("siteScopeStatus").textContent = text;
}
async function renderAllStatus() {
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: ["*://*/*"] });
  } catch {
    /* permissions API unavailable outside an extension page. */
  }
  $("grantAll").hidden = granted;
  $("revokeAll").hidden = !granted;
  $("allStatus").textContent = granted
    ? "已授权所有网站，打开网页时会自动运行。"
    : "尚未授权所有网站。点「允许在所有网站运行」后，Chrome 才会显示权限提示。";
}
async function renderRemembered() {
  const box = $("rememberedSites");
  if (!rememberedSites.length) {
    const empty = document.createElement("p");
    empty.textContent =
      "还没有记住任何网站。在这个模式下点 VOKA 工具栏图标，即可记住当前网站。";
    box.replaceChildren(empty);
    return;
  }
  const states = await Promise.all(
    rememberedSites.map(async (host) => ({
      host,
      granted: await chrome.permissions
        .contains({ origins: [sitePattern(host)] })
        .catch(() => false),
    })),
  );
  box.replaceChildren(
    ...states.map(({ host, granted }) => {
      const row = document.createElement("div");
      row.className = "siteRow";
      const name = document.createElement("code");
      name.textContent =
        host +
        (hostMatchesDeny(host, initial.denyList)
          ? " · 在禁用名单中，不会自动运行"
          : granted
            ? ""
            : " · 未授权，不会自动运行");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "撤销授权";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await chrome.permissions.remove({ origins: [sitePattern(host)] });
          rememberedSites = rememberedSites.filter((site) => site !== host);
          await chrome.storage.local.set({ rememberedSites });
          await chrome.runtime.sendMessage({ type: "sync-site-scope" });
          siteScopeMessage(`已撤销 ${host} 的网站授权，不再自动运行。`);
        } catch (error) {
          siteScopeMessage(`撤销授权失败：${error}`);
        } finally {
          void renderRemembered();
        }
      });
      row.append(name, remove);
      return row;
    }),
  );
}
function renderSiteScope() {
  for (const radio of siteScopeRadios)
    radio.checked = radio.value === siteScope;
  $("rememberedPanel").hidden = siteScope !== "remembered";
  $("allPanel").hidden = siteScope !== "all";
  void renderRemembered();
  if (siteScope === "all") void renderAllStatus();
}
for (const radio of siteScopeRadios)
  radio.addEventListener("change", async () => {
    if (!radio.checked) return;
    siteScope = radio.value as SiteScope;
    try {
      await chrome.storage.local.set({ siteScope });
      await chrome.runtime.sendMessage({ type: "sync-site-scope" });
      siteScopeMessage(
        siteScope === "activeTab"
          ? "已改为点图标才运行；不会自动运行任何网站。"
          : siteScope === "remembered"
            ? "已改为记住启用过的网站；请在工具栏菜单中打开当前网站的自动运行开关。"
            : "已改为所有网站；自动运行遵循当前网站授权和禁用名单。",
      );
    } catch (error) {
      siteScopeMessage(`保存失败：${error}`);
    }
    renderSiteScope();
  });
$("grantAll").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("grantAll");
  button.disabled = true;
  try {
    const granted = await chrome.permissions.request({
      origins: ["*://*/*"],
    });
    await chrome.runtime.sendMessage({ type: "sync-site-scope" });
    siteScopeMessage(
      granted
        ? "已授权所有网站。打开任意网页时会自动运行。"
        : "没有授权所有网站，仍只能手动点图标运行。",
    );
  } catch (error) {
    $("allStatus").textContent = `权限请求失败：${error}`;
  } finally {
    button.disabled = false;
    await renderAllStatus();
  }
});
$("revokeAll").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("revokeAll");
  button.disabled = true;
  try {
    await chrome.permissions.remove({ origins: ["*://*/*"] });
    await chrome.runtime.sendMessage({ type: "sync-site-scope" });
    siteScopeMessage("已撤销所有网站授权，不再自动运行任何网站。");
  } catch (error) {
    $("allStatus").textContent = `撤销失败：${error}`;
  } finally {
    button.disabled = false;
    await renderAllStatus();
  }
});
async function saveDenyList(entries: string[]) {
  await chrome.storage.local.set({ denyList: entries });
  await chrome.runtime.sendMessage({ type: "sync-site-scope" });
  initial.denyList = entries;
  void renderRemembered();
}
$("saveDenyList").addEventListener("click", async () => {
  const parsed = parseDenyList(denyListInput.value);
  const entered = denyListInput.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")).length;
  denyListInput.value = parsed.join("\n");
  try {
    await saveDenyList(parsed);
    const ignored = entered - parsed.length;
    $("denyListStatus").textContent =
      `已保存 ${parsed.length} 个域名` +
      (ignored > 0 ? `，忽略 ${ignored} 个重复或无法识别的条目。` : "。");
  } catch (error) {
    $("denyListStatus").textContent = `保存失败：${error}`;
  }
});
$("resetDenyList").addEventListener("click", async () => {
  denyListInput.value = DEFAULT_DENY_SITES.join("\n");
  try {
    await saveDenyList([...DEFAULT_DENY_SITES]);
    $("denyListStatus").textContent = `已恢复默认名单（${DEFAULT_DENY_SITES.length} 个域名）。`;
  } catch (error) {
    $("denyListStatus").textContent = `保存失败：${error}`;
  }
});
renderSiteScope();
for (const select of [nativeLanguage, glossLanguage])
  select.addEventListener("change", () => {
    showGloss();
    void saveLearning();
  });
for (const level of LEVELS) {
  const option = document.createElement("option");
  option.value = level;
  option.textContent = level;
  importLevel.append(option);
}
importLevel.value = targetLevel;
importLevel.addEventListener("change", invalidate);
try {
  const data = await loadData();
  for (const level of LEVELS) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "targetLevel";
    input.value = level;
    input.checked = level === targetLevel;
    input.addEventListener("change", () => {
      targetLevel = level;
      importLevel.value = level;
      invalidate();
      $("levelHint").textContent = `目标等级已切换为 ${level}：只改变高亮目标，不会删除、移动或重置旧卡。如果 ${level} 还没导入，可以在下面的「等级导入」里预览并导入。`;
      void saveLearning();
    });
    label.append(
      input,
      `${level} · ${data.pack.entries.filter((e) => e.level === level).length.toLocaleString()} 词`,
    );
    $("levels").append(label);
  }
} catch {
  $("levels").textContent = "词表加载失败，请刷新页面重试";
  $<HTMLButtonElement>("nextLearning").disabled = true;
}
async function showPreview() {
  const level = importLevel.value as Level;
  $("importStatus").textContent = "正在读取 Anki…";
  const result = await chrome.runtime.sendMessage({
    type: "preview-import",
    level,
  });
  if (result.error) throw new Error(result.error);
  const p = result.data;
  const conflicts: string[] =
    p.conflicts ??
    p.rows
      .filter((r: { state: string }) => r.state === "conflict")
      .map((r: { key: string }) => r.key);
  const targetLine =
    `目标牌组：${p.target.deck} · ${p.deckExists ? "已存在" : "新建"}\n` +
    `笔记类型：${p.target.noteType} · ${p.typeExists ? "已存在" : "新建"}`;
  const countLine = `数据包 ${(p.total ?? p.rows?.length ?? 0).toLocaleString()} 词 · 本次 ${level} ${(p.selected ?? p.rows?.length ?? 0).toLocaleString()} 词：新建 ${p.counts.new.toLocaleString()} / 已存在 ${p.counts.existing.toLocaleString()} / 冲突 ${p.counts.conflict.toLocaleString()} / 跳过 ${p.counts.skipped.toLocaleString()}（其他等级）`;
  const conflictLine = conflicts.length
    ? `冲突 Key（同一 Key 有多条笔记，已列出并跳过）：\n${conflicts.join("\n")}`
    : "冲突 Key：无";
  const sourceLine = `${p.source}\n${p.license} · ${p.version}`;
  $("importTarget").textContent = targetLine;
  $("importCounts").textContent = countLine;
  $("importConflicts").textContent = conflictLine;
  $("importSource").textContent = sourceLine;
  $("importStatus").textContent = "";
  await showUpgradeSummary();
  previewLevel = level;
  previewNew = p.counts.new;
  confirmButton.textContent =
    p.counts.new === 0 ? "没有需要新建的笔记" : "确认导入";
  confirmButton.disabled = p.counts.new === 0;
  $<HTMLButtonElement>("finish").disabled = p.counts.new !== 0;
  layout();
  return p as { counts: { new: number } };
}
async function runImport(execute: boolean) {
  busy = true;
  executing = execute;
  layout();
  try {
    if (execute) {
      if (previewLevel !== importLevel.value)
        throw new Error("请先预览当前等级");
      progress.hidden = false;
      progress.value = 0;
      $("importProgressText").textContent = "准备导入…";
      const result = await chrome.runtime.sendMessage({
        type: "execute-import",
        level: previewLevel,
      });
      if (result.error) throw new Error(result.error);
      const data = result.data as {
        confirmed: string[];
        failures: { key: string; reason: string }[];
        conflicts: string[];
        cancelled: boolean;
        interrupted: boolean;
        total: number;
        created: number;
        remaining: number;
      };
      executing = false;
      lastRunInterrupted = data.interrupted || data.cancelled;
      const state = data.cancelled
        ? "已取消"
        : data.interrupted
          ? "连接中断"
          : "已完成";
      $("importProgressText").textContent =
        `${state}：本次新建 ${data.confirmed.length.toLocaleString()} 条` +
        (data.remaining
          ? data.interrupted
            ? `，剩余 ${data.remaining.toLocaleString()} 条。恢复连接后可点「继续导入」只补剩下的。`
            : data.cancelled
              ? `，剩余 ${data.remaining.toLocaleString()} 条。可点「继续导入」只补剩下的。`
              : `，剩余 ${data.remaining.toLocaleString()} 条。`
          : "。");
      const failureText = data.failures
        .map((f) => `${f.key}: ${f.reason}`)
        .join("\n");
      let preview: { counts: { new: number } } | undefined;
      try {
        preview = await showPreview();
      } catch (error) {
        $("importProgressText").textContent +=
          `\n刷新预览失败：${String(error)}`;
      }
      $("importStatus").textContent +=
        `\n${state}：本次回读确认 ${data.confirmed.length.toLocaleString()} 条` +
        (failureText ? `\n未完成：\n${failureText}` : "");
      if (lastRunInterrupted && (preview?.counts.new ?? data.remaining) > 0) {
        const remaining = preview?.counts.new ?? data.remaining;
        confirmButton.textContent = `继续导入（剩余 ${remaining.toLocaleString()} 条）`;
        confirmButton.disabled = false;
      }
    } else {
      await showPreview();
      lastRunInterrupted = false;
    }
  } catch (error) {
    if (!lastRunInterrupted) invalidate();
    $("importStatus").textContent = String(error);
    $("importProgressText").textContent = String(error);
  } finally {
    busy = false;
    executing = false;
    layout();
  }
}
$("preview").addEventListener("click", () => void runImport(false));
confirmButton.addEventListener("click", () => void runImport(true));
cancelButton.addEventListener("click", async () => {
  cancelButton.disabled = true;
  $("importProgressText").textContent =
    "正在取消：当前批次完成后停止，已经写入的笔记会保留。";
  await chrome.runtime.sendMessage({ type: "cancel-import" });
});
chrome.runtime.onMessage.addListener((message) => {
  if (!busy || message?.type !== "import-progress") return;
  const p = message.data as {
    phase: string;
    batch: number;
    batches: number;
    processed: number;
    total: number;
    created: number;
    failed: number;
  };
  if (typeof p?.total !== "number") return;
  progress.hidden = false;
  progress.max = Math.max(1, p.total);
  progress.value = p.processed;
  const phase = {
    preparing: "准备",
    validating: "预检",
    writing: "写入",
    reading: "回读",
    "batch-done": "完成一批",
    cancelled: "已取消",
    interrupted: "连接中断",
    done: "完成",
  }[p.phase];
  $("importProgressText").textContent =
    `${phase ?? p.phase}：第 ${p.batch}/${p.batches} 批 · 已处理 ${p.processed.toLocaleString()}/${p.total.toLocaleString()} · 新建 ${p.created.toLocaleString()}` +
    (p.failed ? ` · 失败 ${p.failed.toLocaleString()}` : "");
});
$("nextConnection").addEventListener("click", () => {
  if (connected) {
    step = 1;
    layout();
  }
});
$("nextLearning").addEventListener("click", async () => {
  await saveLearning();
  step = 2;
  layout();
  await runImport(false);
});
$("backConnection").addEventListener("click", () => {
  step = 0;
  layout();
});
$("backLearning").addEventListener("click", () => {
  step = 1;
  layout();
});
for (const id of ["skip", "finish"])
  $(id).addEventListener("click", () => {
    location.href = chrome.runtime.getURL("options.html");
  });
layout();
// Spec 13.1: check the saved port (default 8765) once as soon as the wizard opens.
// There is no polling; only 重新检测 or a page reload checks again.
await refresh();
// Render source metadata and complete upstream notices without interpreting data as HTML.
async function showAttributions() {
  const section = document.createElement("section");
  section.id = "about";
  section.hidden = wizard;
  section.inert = !connected;
  section.style.opacity = connected ? "1" : ".45";
  const heading = document.createElement("h2");
  heading.textContent = t("aboutTitle");
  section.append(heading);
  document.querySelector("main")!.append(section);
  try {
    const response = await fetch(
      chrome.runtime.getURL("data/attributions.json"),
    );
    if (!response.ok) throw new Error(String(response.status));
    const metadata = await response.json();
    for (const pack of metadata.packs) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${pack.source[0].split("/").pop()} · ${pack.license} · ${pack.version}`;
      const text = document.createElement("p");
      text.textContent = `${pack.attribution} ${pack.dataVersion} · ${pack.generatedDate} · ${pack.entryCount}`;
      const link = document.createElement("a");
      link.href = pack.licenseUrl;
      link.textContent = pack.license;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      details.append(summary, text, link);
      section.append(details);
    }
    for (const [name, notice] of Object.entries(metadata.notices)) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = name;
      const text = document.createElement("pre");
      text.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
      text.textContent = String(notice);
      details.append(summary, text);
      section.append(details);
    }
  } catch {
    const error = document.createElement("p");
    error.textContent = t("dataLoadError");
    section.append(error);
  }
}
void showAttributions();

const storeFullUrl = document.querySelector<HTMLInputElement>("#storeFullUrl")!;
storeFullUrl.checked = initial.storeFullUrl;
storeFullUrl.addEventListener("change", () =>
  chrome.storage.local.set({ storeFullUrl: storeFullUrl.checked }),
);
const youtubeDiagnostics = $("youtubeDiagnostics") as HTMLInputElement;
youtubeDiagnostics.checked = initial.youtubeDiagnostics;
$("youtubeDiagnosticsLabel").textContent = t("youtubeDiagnostics");
youtubeDiagnostics.addEventListener("change", () =>
  chrome.storage.local.set({ youtubeDiagnostics: youtubeDiagnostics.checked }),
);
const youtubeAutoResume = $("youtubeAutoResume") as HTMLInputElement;
youtubeAutoResume.checked = initial.youtubeAutoResume;
$("youtubeAutoResumeLabel").textContent = t("youtubeAutoResume");
youtubeAutoResume.addEventListener("change", () =>
  chrome.storage.local.set({ youtubeAutoResume: youtubeAutoResume.checked }),
);

// Upgrade confirmation is separate from level import: neither preview writes notes.
$("checkUpgrade").onclick = () => void upgradeUI.preview();
async function showUpgradeSummary() {
  const box = $("importUpgrade");
  box.replaceChildren();
  try {
    const response = await chrome.runtime.sendMessage({ type: "upgrade-summary" });
    if (response.error) throw new Error(response.error);
    if (!response.data.count) return;
    const line = document.createElement("p");
    line.textContent = `已有 ${response.data.count} 张词卡的释义有更新`;
    const button = document.createElement("button");
    button.textContent = "查看";
    button.onclick = () => { $("updates").hidden = false; void upgradeUI.preview(); $("updates").scrollIntoView(); };
    box.append(line, button);
  } catch (error) { box.textContent = `释义更新检查失败：${String(error)}`; }
}
if (connected && new URLSearchParams(location.search).has("upgrade")) {
  await upgradeUI.preview();
  $("updates").scrollIntoView();
}

async function showKeptCount() {
  const count = Object.keys(await readUpgradeKept()).length;
  $("upgradeKeptCount").textContent = `已保留 ${count} 张词卡的更新`;
  ($("resetUpgradeKept") as HTMLButtonElement).disabled = count === 0;
}
$("resetUpgradeKept").onclick = async () => {
  await clearUpgradeKept();
  await showKeptCount();
  await upgradeUI.preview();
  await showUpgradeSummary();
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.upgradeKept) {
    void showKeptCount();
    if (connected) void showUpgradeSummary();
  }
});
void showKeptCount();
