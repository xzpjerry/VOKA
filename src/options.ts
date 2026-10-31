import { settings, check, t } from "./shared";
import { LEVELS, loadData, type Level } from "./data";
import type { Status } from "./background/gateway";
const style = document.createElement("style");
style.textContent = `body{font:16px/1.6 system-ui;color:#24342e;background:#f4f6f2;margin:0}main{max-width:840px;margin:48px auto;padding:0 24px 64px}.brand{color:#56745e;letter-spacing:.08em}h1{font-size:36px}section,fieldset{min-width:0;border:1px solid #dce4db;border-radius:16px;padding:24px;background:white;margin:20px 0}fieldset:disabled{opacity:.45}h2{margin-top:0}label{display:inline-flex;flex-direction:column;gap:6px;margin:8px 16px 12px 0}input,select,button{font:inherit;padding:9px 12px;border:1px solid #c5d1c6;border-radius:8px}button{cursor:pointer;background:#edf3e9;margin:4px}button:disabled{cursor:default;opacity:.5}.levels{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.levels label{border:1px solid #dce4db;padding:12px;margin:0}.levels label:has(:checked){border-color:#386344;background:#f0f6ec}ol{padding-left:24px}li{padding:8px}li[data-state=bad]{color:#8c352c}li[data-state=wait]{color:#7d847f}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}details{margin:12px 0}[hidden]{display:none!important}@media(max-width:600px){.levels{grid-template-columns:repeat(2,1fr)}}`;
document.head.append(style);
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const wizard = new URLSearchParams(location.search).has("wizard");
let step = 0;
let connected = false;
let busy = false;
let previewLevel: Level | undefined;
const initial = await settings();
const port = $<HTMLInputElement>("port");
const apiKey = $<HTMLInputElement>("apiKey");
const nativeLanguage = $<HTMLSelectElement>("nativeLanguage");
const glossLanguage = $<HTMLSelectElement>("glossLanguage");
const importLevel = $<HTMLSelectElement>("importLevel");
const confirmButton = $<HTMLButtonElement>("confirm");
port.value = String(initial.port);
apiKey.value = initial.apiKey;
nativeLanguage.value = initial.nativeLanguage;
glossLanguage.value = initial.glossLanguage;
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
    $<HTMLFieldSetElement>(id).disabled = !connected || busy;
  }
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
  confirmButton.disabled = true;
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
    });
    $("saveStatus").textContent = "已保存";
  } catch {
    $("saveStatus").textContent = "保存失败，请重试";
    throw new Error("保存失败");
  }
}
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
  const result = await chrome.runtime.sendMessage({
    type: "preview-import",
    level,
  });
  if (result.error) throw new Error(result.error);
  const p = result.data;
  $("importStatus").textContent =
    `目标牌组：${p.target.deck} · ${p.deckExists ? "已存在" : "新建"}\n笔记类型：${p.target.noteType} · ${p.typeExists ? "已存在" : "新建"}\n新建 ${p.counts.new} / 已存在 ${p.counts.existing} / 冲突 ${p.counts.conflict} / 跳过 ${p.counts.skipped}\n${p.rows
      .filter((r: { state: string }) => r.state === "conflict")
      .map((r: { key: string }) => r.key)
      .join("\n")}\n${p.source}\n${p.license} · ${p.version}`;
  previewLevel = level;
  confirmButton.disabled = p.counts.new === 0;
  $<HTMLButtonElement>("finish").disabled = p.counts.new !== 0;
}
async function runImport(execute: boolean) {
  busy = true;
  layout();
  try {
    if (execute) {
      if (previewLevel !== importLevel.value)
        throw new Error("请先预览当前等级");
      const result = await chrome.runtime.sendMessage({
        type: "execute-import",
        level: previewLevel,
      });
      if (result.error) throw new Error(result.error);
      await showPreview();
      $("importStatus").textContent +=
        `\n已确认：${result.data.confirmed.length}\n${result.data.failures.map((f: { key: string; reason: string }) => `${f.key}: ${f.reason}`).join("\n")}`;
    } else await showPreview();
  } catch (error) {
    invalidate();
    $("importStatus").textContent = String(error);
  } finally {
    busy = false;
    layout();
  }
}
$("preview").addEventListener("click", () => void runImport(false));
confirmButton.addEventListener("click", () => void runImport(true));
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
