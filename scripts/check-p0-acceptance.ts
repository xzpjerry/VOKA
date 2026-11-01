/** #36 verification only. Fixed test endpoint; runs existing harnesses sequentially.
 * npm run build && npm test && npm run check:p0
 * --only=name[,name] selects steps; --child=name is internal.
 * Each browser gets a disposable extension/profile and a Chrome NetLog. The sole
 * background change seeds port 8766 before the install wizard can read defaults.
 * Product source and built dist are never changed by this wrapper.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  readdir,
} from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:http";
import puppeteer from "puppeteer";
const root = "docs/research/p0-evidence";
const steps: Record<
  string,
  { file: string; tests: string[]; evidence?: string[] }
> = {
  anki: { file: "check-anki.ts", tests: ["T-01"] },
  import: { file: "check-import.ts", tests: ["T-04", "T-05"] },
  level: {
    file: "check-level-import.ts",
    tests: ["T-03", "T-04", "T-06", "T-07"],
    evidence: ["level-import-evidence"],
  },
  highlight: {
    file: "check-highlight.ts",
    tests: ["T-01", "T-30"],
    evidence: ["highlight-evidence", "drawer-evidence"],
  },
  manual: {
    file: "check-manual.ts",
    tests: ["T-08"],
    evidence: ["manual-status-evidence"],
  },
  dynamic: {
    file: "check-dynamic.ts",
    tests: ["T-09"],
    evidence: ["dynamic-performance.json"],
  },
  contexts: {
    file: "check-contexts.ts",
    tests: ["T-10", "T-11", "T-32"],
    evidence: ["context-evidence"],
  },
  data: { file: "check-data.ts", tests: ["T-03", "T-11"] },
  gloss: {
    file: "check-gloss.ts",
    tests: ["T-26", "T-27"],
    evidence: ["gloss-switch-raw.json"],
  },
  candidates: {
    file: "check-candidates.ts",
    tests: ["T-28"],
    evidence: ["lemma-candidates-evidence"],
  },
  upgrade: {
    file: "check-gloss-upgrade.ts",
    tests: ["T-29"],
    evidence: ["gloss-upgrade-evidence"],
  },
  onboarding: {
    file: "check-onboarding.ts",
    tests: ["T-02"],
    evidence: ["onboarding-evidence"],
  },
  scope: {
    file: "check-site-scope.ts",
    tests: ["T-31"],
    evidence: ["site-scope-evidence"],
  },
  cold: {
    file: "check-scope-cold-start.ts",
    tests: ["T-31"],
    evidence: ["site-scope-cold-start-evidence"],
  },
  supplemental: { file: "", tests: ["T-03", "T-05", "T-33"] },
  final: {
    file: "",
    tests: [
      "T-03",
      "T-04",
      "T-06",
      "T-07",
      "T-11",
      "T-26",
      "T-27",
      "T-30",
      "T-31",
    ],
  },
  lifecycle: { file: "", tests: ["T-01"] },
  permission: { file: "", tests: ["T-02"] },
};
const child = process.argv.find((a) => a.startsWith("--child="))?.split("=")[1];
await mkdir(root, { recursive: true });
if (child) {
  assert(steps[child]);
  const directory = resolve(root, child);
  await mkdir(directory, { recursive: true });
  // Guard Node-side calls too; retain request/response evidence for v1 operations.
  const realFetch = globalThis.fetch;
  const rpcLog: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    assert(
      !/^https?:\/\/(127\.0\.0\.1|localhost):8765(?:\/|$)/.test(url),
      "forbidden port",
    );
    const request = JSON.parse(String(init?.body || "{}"));
    if (url.includes(":8766/"))
      assert(
        !/^(collection\.sync|scheduling\.|cards\.move|noteTypes\.editStructure)/.test(
          request.method,
        ),
      );
    const response = await realFetch(input, init);
    if (url.includes(":8766/")) {
      rpcLog.push({ url, request, response: await response.clone().json() });
    }
    return response;
  };
  const originalLaunch = puppeteer.launch.bind(puppeteer);
  let launches = 0;
  const network: unknown[] = [];
  puppeteer.launch = async (options: any = {}) => {
    const index = ++launches;
    const temporary = await mkdtemp(resolve(tmpdir(), "voka-p0-browser-"));
    const extensions = [];
    for (const [i, path] of (options.enableExtensions || []).entries()) {
      const extension = resolve(temporary, "extension-" + i);
      await cp(path, extension, { recursive: true });
      const background = resolve(extension, "background.js");
      await writeFile(
        background,
        'chrome.storage.local.get("port").then(v => typeof v.port === "number" ? undefined : chrome.storage.local.set({port:8766,apiKey:""}));\n' +
          (await readFile(background, "utf8")),
      );
      extensions.push(extension);
    }
    const evidenceNetlog = resolve(directory, `chrome-netlog-${index}.json.gz`);
    const suppliedNetlog = options.args
      ?.find((a: string) => a.startsWith("--log-net-log="))
      ?.slice("--log-net-log=".length);
    const netlog =
      suppliedNetlog || resolve(directory, `chrome-netlog-${index}.json`);
    const browser = await originalLaunch({
      ...options,
      enableExtensions: extensions.length
        ? extensions
        : options.enableExtensions,
      args: [...(options.args || []), `--log-net-log=${netlog}`],
    });
    const instrument = (page: any) => {
      if (page.__p0Instrumented) return;
      page.__p0Instrumented = true;
      for (const method of ["click", "select"]) {
        const original = page[method].bind(page);
        page[method] = async (...args: any[]) => {
          await page.bringToFront();
          if (method === "click") return page.locator(args[0]).click(args[1]);
          return original(...args);
        };
      }
      const click = page.mouse.click.bind(page.mouse);
      page.mouse.click = async (...args: any[]) => {
        await page.bringToFront();
        return click(...args);
      };
    };
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      instrument(page);
      return page;
    };
    browser.on("targetcreated", async (target) => {
      const page = await target.page().catch(() => null);
      if (page) instrument(page);
    });
    for (const page of await browser.pages()) instrument(page);
    const version = await browser.version();
    const close = browser.close.bind(browser);
    browser.close = async () => {
      await close();
      const log = JSON.parse(await readFile(netlog, "utf8"));
      const urls = [
        ...new Set(
          log.events.flatMap((e: any) =>
            typeof e.params?.url === "string" ? [e.params.url] : [],
          ),
        ),
      ] as string[];
      const forbidden = urls.filter((u) =>
        /^https?:\/\/(127\.0\.0\.1|localhost):8765(?:\/|$)/.test(u),
      );
      network.push({
        browser: version,
        netlog: `chrome-netlog-${index}.json.gz`,
        urls,
        forbidden,
      });
      await writeFile(
        resolve(directory, "network.json"),
        JSON.stringify(network, null, 2) + "\n",
      );
      await writeFile(evidenceNetlog, gzipSync(await readFile(netlog)));
      if (!suppliedNetlog) await rm(netlog);
      await rm(temporary, { recursive: true, force: true });
      assert.equal(forbidden.length, 0, "Chrome requested forbidden port 8765");
    };
    console.log("Chrome", await browser.version());
    return browser;
  };
  try {
    if (child === "lifecycle") await lifecycleCheck(directory);
    else if (child === "permission") await permissionCheck(directory);
    else if (child === "final") await finalChecks(directory);
    else if (child === "supplemental") await supplemental(directory);
    else await import("./" + steps[child].file);
  } finally {
    await writeFile(
      resolve(directory, "rpc.json.gz"),
      gzipSync(JSON.stringify(rpcLog, null, 2) + "\n"),
    );
  }
} else {
  assert.equal(
    execFileSync("git", ["diff", "origin/main", "--", "src", "public"], {
      encoding: "utf8",
    }),
    "",
    "Acceptance must verify unmodified product code from current origin/main.",
  );
  const only = process.argv
    .find((a) => a.startsWith("--only="))
    ?.split("=")[1]
    .split(",");
  for (const name of only ?? [])
    assert(steps[name], `Unknown harness: ${name}`);
  const productCommit = execFileSync("git", ["rev-parse", "origin/main"], {
    encoding: "utf8",
  }).trim();
  const previous = only
    ? await readFile(resolve(root, "results.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null)
    : null;
  const reusable =
    previous && (previous.productCommit ?? previous.commit) === productCommit;
  const results: any = {
    started: reusable ? previous.started : new Date().toISOString(),
    productCommit,
    reruns: reusable
      ? [
          ...(previous.reruns ?? []),
          { at: new Date().toISOString(), selected: only },
        ]
      : [],
    replacedSteps: reusable
      ? [
          ...(previous.replacedSteps ?? []),
          ...previous.steps.filter((step: any) => only?.includes(step.name)),
        ]
      : [],
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim(),
    endpoint: "http://127.0.0.1:8766/api/v1",
    steps: reusable
      ? previous.steps.filter((step: any) => !only?.includes(step.name))
      : [],
  };
  for (const [name, step] of Object.entries(steps)) {
    if (only && !only.includes(name)) continue;
    const directory = resolve(root, name);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const started = Date.now();
    console.log("START", name, step.tests.join(","));
    const output: string[] = [];
    const code = await new Promise<number>((done) => {
      const proc = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/check-p0-acceptance.ts"),
          `--child=${name}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      for (const pipe of [proc.stdout, proc.stderr])
        pipe.on("data", (data) => {
          output.push(data.toString());
          process.stdout.write(data);
        });
      proc.on("exit", (c) => done(c ?? 1));
    });
    await writeFile(resolve(directory, "run.log"), output.join(""));
    for (const evidence of step.evidence || [])
      await cp(
        resolve("docs/research", evidence),
        resolve(directory, evidence),
        {
          recursive: true,
          filter: async (path) => {
            const info = await stat(path);
            return info.isDirectory() || info.mtimeMs >= started - 1000;
          },
        },
      ).catch(() => {});
    results.steps.push({
      name,
      tests: step.tests,
      exitCode: code,
      result: code === 0 ? "PASS" : "FAIL",
      startedAt: new Date(started).toISOString(),
      elapsedMs: Date.now() - started,
      evidence: `${root}/${name}`,
    });
    await writeFile(
      resolve(root, "results.json"),
      JSON.stringify(results, null, 2) + "\n",
    );
    console.log("END", name, code);
  }
  const primary: Record<string, string> = {
    "T-01": "lifecycle",
    "T-02": "permission",
    "T-03": "final",
    "T-04": "final",
    "T-05": "supplemental",
    "T-06": "final",
    "T-07": "final",
    "T-08": "manual",
    "T-09": "dynamic",
    "T-10": "contexts",
    "T-11": "final",
    "T-26": "final",
    "T-27": "final",
    "T-28": "candidates",
    "T-29": "upgrade",
    "T-30": "final",
    "T-31": "final",
    "T-32": "contexts",
    "T-33": "supplemental",
  };
  results.tests = [];
  for (const [id, name] of Object.entries(primary)) {
    const step = results.steps.find((entry: any) => entry.name === name);
    let status = step?.result ?? "NOT RUN";
    if (name === "permission" && step?.exitCode === 0) {
      const permission = JSON.parse(
        await readFile(resolve(root, name, "results.json"), "utf8"),
      );
      status = permission.result;
    }
    results.tests.push({
      id,
      result: status,
      primaryHarness: name,
      evidence: step?.evidence ?? null,
    });
  }
  results.counts = Object.fromEntries(
    ["PASS", "FAIL", "PARTIAL", "NOT RUN"].map((status) => [
      status,
      results.tests.filter((test: any) => test.result === status).length,
    ]),
  );
  const audit: any = { files: [], forbiddenLoopbackRequests: 0 };
  for (const step of results.steps) {
    const folder = resolve(step.evidence);
    for (const filename of await readdir(folder)) {
      if (!/^chrome-netlog-.*\.json\.gz$/.test(filename)) continue;
      const raw = gunzipSync(
        await readFile(resolve(folder, filename)),
      ).toString("utf8");
      const log = JSON.parse(raw);
      const forbidden = log.events.filter((event: any) =>
        /(?:127\.0\.0\.1|localhost|\[::1\]):8765\b/.test(
          JSON.stringify(event.params ?? {}),
        ),
      );
      audit.files.push({
        harness: step.name,
        path: step.evidence + "/" + filename,
        eventCount: log.events.length,
        forbiddenEvents: forbidden.length,
      });
      audit.forbiddenLoopbackRequests += forbidden.length;
    }
  }
  assert.equal(
    audit.forbiddenLoopbackRequests,
    0,
    "Chrome NetLog contains forbidden loopback 8765",
  );
  await writeFile(
    resolve(root, "network-audit.json"),
    JSON.stringify(audit, null, 2) + "\n",
  );
  results.finished = new Date().toISOString();
  await writeFile(
    resolve(root, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  process.exitCode = results.steps.some((s: any) => s.exitCode !== 0) ? 1 : 0;
}

async function supplemental(directory: string) {
  // Extra acceptance gaps are implemented below; no sync, structure or scheduler API.
  const { rpc } = await import("../src/background/gateway.ts");
  const { loadData } = await import("../src/data/index.ts");
  const { executeImport, previewImport, lookup, CORE_FIELDS } = await import(
    "../src/background/import.ts"
  );
  const data = await loadData(async (name) =>
    JSON.parse(await readFile(`public/data/${name}.json`, "utf8")),
  );
  const call = async (
    method: string,
    params: any = {},
    write = false,
  ): Promise<any> =>
    rpc({ port: 8766, apiKey: "" }, method, params, { sideEffecting: write });
  const result: any = { date: new Date().toISOString(), checks: {} };
  const save = () =>
    writeFile(
      resolve(directory, "results.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
  const snapshot = () =>
    JSON.parse(
      execFileSync("python3", ["scripts/anki-snapshot.py"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  const stamp = Date.now();
  const target = {
    noteType: `VOKA P0 Acceptance ${stamp}`,
    deck: `VOKA::P0 Acceptance ${stamp}::B1`,
  };
  result.target = target;
  const imported = await executeImport(
    call,
    target,
    "native",
    "zh",
    data.pack.entries,
  );
  assert.equal(imported.created, 2085);
  assert.deepEqual(imported.failures, []);
  const keys = data.pack.entries
    .filter((e) => e.level === "B1")
    .map((e) => "en:" + e.lemma);
  const matched = await lookup(call, target, keys);
  assert([...matched.values()].every((ids) => ids.length === 1));
  result.checks["T-03"] = {
    count: 2085,
    specEstimate: 2088,
    difference: -3,
    target,
  };
  await save();
  // Drive actual isolated Anki reviewer, never synthetic scheduling writes.
  const operation = async (method: string, params: any) => {
    const handle = await call(method, params, true);
    if (!handle.operationId) return handle;
    for (let i = 0; i < 100; i++) {
      const state = await call("operations.get", {
        operationId: handle.operationId,
      });
      if (state.state === "succeeded") return state.result;
      if (["failed", "cancelled"].includes(state.state))
        throw Error(JSON.stringify(state));
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Operation timed out");
  };
  await operation("application.navigate", {
    view: "review",
    deck: { name: target.deck },
  });
  const reviewed = [];
  for (let i = 0; i < 3; i++) {
    let state = await call("reviewer.get");
    assert(state.stateToken && state.card, "reviewer has no card");
    await call("reviewer.showAnswer", { stateToken: state.stateToken }, true);
    state = await call("reviewer.get");
    reviewed.push(state.card);
    await operation("reviewer.answer", {
      stateToken: state.stateToken,
      rating: "good",
    });
  }
  await operation("application.navigate", { view: "deckBrowser" });
  const before = snapshot();
  assert(before.revlog.length >= 3);
  const ids = reviewed.map((c: any) => c.noteId);
  const oldNotes = await call("notes.getMany", { ids: [...new Set(ids)] });
  const adjacent = { ...target, deck: target.deck.replace(/B1$/, "B2") };
  const adjacentRun = await executeImport(
    call,
    adjacent,
    "native",
    "zh",
    data.pack.entries,
  );
  assert.deepEqual(adjacentRun.failures, []);
  const after = snapshot();
  assert.deepEqual(after.revlog, before.revlog);
  for (const card of before.cards)
    assert.deepEqual(
      after.cards.find((c: any) => c[0] === card[0]),
      card,
    );
  assert.deepEqual(
    await call("notes.getMany", { ids: [...new Set(ids)] }),
    oldNotes,
  );
  result.checks["T-05"] = {
    reviewed,
    revlogRows: before.revlog.length,
    adjacentCreated: adjacentRun.created,
    allPriorCardsAndRevlogUnchanged: true,
    reviewedFieldsUnchanged: true,
    sync: "not called",
  };
  await save();
  // v1 duplicate and batch semantics; separate test type, no structure edits.
  const type = { name: `VOKA P0 v1 ${stamp}` };
  await call(
    "noteTypes.create",
    {
      name: type.name,
      fields: [{ name: "Key" }, { name: "Word" }, { name: "Keep" }],
      templates: [
        {
          name: "Card",
          questionHtml: "{{Key}}",
          answerHtml: "{{Word}} {{Keep}}",
        },
      ],
    },
    true,
  );
  const deck = { name: `VOKA::P0 v1 ${stamp}` };
  await call("decks.create", deck, true);
  const otherDeck = { name: deck.name + " other" };
  await call("decks.create", otherDeck, true);
  const note = (key: string, extra: any = {}) => ({
    noteType: type,
    deck,
    fields: { Key: key, Word: "original", Keep: "preserved" },
    ...extra,
  });
  const seed = await call(
    "notes.createMany",
    { notes: [note("en:seed")] },
    true,
  );
  const validity = async (n: any) =>
    (await call("notes.validateMany", { notes: [n] })).items[0].result.valid;
  assert.equal(await validity(note("en:seed")), false);
  assert.equal(await validity(note("En:Seed")), true);
  assert.equal(await validity(note("<b>en:seed</b>")), false);
  assert.equal(await validity(note("en:seed", { deck: otherDeck })), false);
  assert.equal(
    await validity(
      note("en:seed", {
        deck: otherDeck,
        duplicates: { scope: "deck", deck: otherDeck },
      }),
    ),
    true,
  );
  assert.equal(
    await validity(note("en:seed", { duplicates: { scope: "deck", deck } })),
    false,
  );
  const otherType = { name: type.name + " other" };
  await call(
    "noteTypes.create",
    {
      name: otherType.name,
      fields: [{ name: "Key" }, { name: "Word" }, { name: "Keep" }],
      templates: [
        { name: "Card", questionHtml: "{{Key}}", answerHtml: "{{Word}}" },
      ],
    },
    true,
  );
  assert.equal(await validity(note("en:seed", { noteType: otherType })), true);
  assert.equal(
    await validity(
      note("en:seed", {
        noteType: otherType,
        duplicates: { acrossNoteTypes: true },
      }),
    ),
    false,
  );
  const invalidResponse = await fetch("http://127.0.0.1:8766/api/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "invalid-scope",
      method: "notes.validateMany",
      params: {
        notes: [note("en:seed", { duplicates: { scope: "invalid" } })],
      },
    }),
  });
  const invalidScope = await invalidResponse.json();
  assert.equal(invalidScope.error.data.type, "invalidParams");
  const nonAtomic = await call(
    "notes.createMany",
    { notes: [note("en:one"), note("en:seed"), note("en:two")], atomic: false },
    true,
  );
  assert(
    nonAtomic.items[0].result &&
      nonAtomic.items[1].error &&
      nonAtomic.items[2].result,
  );
  let atomicError;
  try {
    await call(
      "notes.createMany",
      {
        notes: [note("en:atomic-one"), note("en:seed"), note("en:atomic-two")],
        atomic: true,
      },
      true,
    );
  } catch (e) {
    atomicError = String(e);
  }
  assert(atomicError);
  assert.equal(
    (
      await call("notes.search", {
        query: `note:"${type.name}" Key:en:atomic-*`,
      })
    ).ids.length,
    0,
  );
  const seedId = seed.items[0].result.noteId;
  await call(
    "notes.update",
    { id: seedId, patch: { fields: { Word: "changed" } } },
    true,
  );
  const merged = (await call("notes.getMany", { ids: [seedId] })).items[0]
    .result;
  assert.deepEqual(merged.fields, {
    Key: "en:seed",
    Word: "changed",
    Keep: "preserved",
  });
  result.checks["T-33"] = {
    caseSensitive: true,
    stripsHtml: true,
    defaultAcrossDecks: true,
    deckScope: true,
    nonAtomic,
    atomicError,
    atomicWroteZero: true,
    mergePreservesFields: true,
    defaultSeparateNoteTypes: true,
    acrossNoteTypes: true,
    invalidScope: invalidScope.error,
    type,
    deck,
  };
  await save();
}

function assertNoAutomaticSync() {
  const state = execFileSync(
    "python3",
    [
      "-c",
      `import pathlib,sqlite3,pickle,json; c=sqlite3.connect(pathlib.Path.home()/'VOKA-anki-test/prefs21.db'); d=pickle.loads(c.execute("select data from profiles where name='User 1'").fetchone()[0]); print(json.dumps(d.get('autoSync',True)))`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    JSON.parse(state),
    false,
    "Disable autoSync in the isolated User 1 profile before lifecycle checks; no full sync is permitted.",
  );
}

async function finalChecks(directory: string) {
  assertNoAutomaticSync();
  const { rpc, checkConnection } = await import("../src/background/gateway.ts");
  const { loadData } = await import("../src/data/index.ts");
  const { executeImport, previewImport, lookup, DEFAULT_TARGET } = await import(
    "../src/background/import.ts"
  );
  const { cardContext } = await import("../src/background/contexts.ts");
  const { replaceGlossCss } = await import("../src/background/gloss.ts");
  const { DEFAULT_DENY_SITES } = await import("../src/site-scope.ts");
  const call = async (
    method: string,
    params: any = {},
    write = false,
  ): Promise<any> =>
    rpc({ port: 8766, apiKey: "" }, method, params, { sideEffecting: write });
  const data = await loadData(async (name) =>
    JSON.parse(await readFile(`public/data/${name}.json`, "utf8")),
  );
  const result: any = {
    started: new Date().toISOString(),
    checks: {},
    limitations: [
      "Real Gmail was not used; mail.google.com is mapped to a local HTTP fixture.",
      "Manual injection uses scripting.executeScript, not a physical toolbar click.",
    ],
  };
  const save = () =>
    writeFile(
      resolve(directory, "results.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
  const snapshot = () =>
    JSON.parse(
      execFileSync("python3", ["scripts/anki-snapshot.py"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  const stamp = Date.now();
  // Temporarily rename existing TEST artifacts, preserving their IDs/cards/reviews.
  // Fresh canonical names prove default provisioning; all new fixtures are archived
  // under this run's clearly named namespace before restoring prior names.
  const originalType = (await call("noteTypes.list")).find(
    (t: any) => t.name === DEFAULT_TARGET.noteType,
  );
  const originalDecks = (await call("decks.list")).filter((d: any) =>
    /^VOKA::English::(A1|A2|B1|B2)$/.test(d.name),
  );
  const priorType = `VOKA P0 Prior ${stamp}`;
  if (originalType)
    await call(
      "noteTypes.update",
      { noteType: { id: originalType.id }, patch: { name: priorType } },
      true,
    );
  for (const deck of originalDecks)
    await call(
      "decks.update",
      {
        deck: { id: deck.id },
        name: `VOKA::P0 Prior ${stamp}::${deck.name.split("::").at(-1)}`,
      },
      true,
    );
  result.prior = { type: originalType, decks: originalDecks };
  await save();
  const config = {
    nativeLanguage: "zh" as const,
    glossLanguage: "native" as const,
    targetLevel: "B1" as const,
    showAdvanced: false,
    hoverScope: "all" as const,
  };
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><title>P0 acceptance fixture</title><style>body{font:22px/2 Georgia;padding:30px;max-width:800px}</style><main><p>We <span id="benefit">benefit</span> from the opportunity and must <span id="abolish">abolish</span> the old plan.</p><p>I <span id="saw">saw</span> a bright <span id="colour">colour</span> near the garden.</p><p>They are <span id="missing">'m</span> and <span id="unlevelled">aardvark</span> in this fixture.</p><input id="input" value="benefit"><textarea id="textarea">benefit</textarea><p contenteditable id="editable">benefit</p><code id="code">benefit</code><nav id="nav">benefit</nav></main>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: [
      "--no-first-run",
      "--host-resolver-rules=MAP mail.google.com 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  try {
    const worker = (await (
      await browser.waitForTarget((t) => t.type() === "service_worker")
    ).worker())!;
    await worker.evaluate(() =>
      chrome.storage.local.set({
        port: 8766,
        apiKey: "",
        targetLevel: "B1",
        hoverScope: "all",
      }),
    );
    const extensionId = worker.url().split("/")[2];
    const options = await browser.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.waitForFunction(
      () => document.querySelector("#status")?.textContent === "已连接",
    );
    await options.locator("#preview").click();
    await options.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#confirm")?.disabled,
    );
    assert.match(
      await options.$eval("#importCounts", (e) => e.textContent!),
      /新建 2,085 \/ 已存在 0/,
    );
    await options.screenshot({
      path: resolve(directory, "default-preview.png"),
      fullPage: true,
    });
    await options.locator("#confirm").click();
    await options.waitForFunction(
      () =>
        document
          .querySelector("#importProgressText")
          ?.textContent?.includes("已完成：本次新建 2,085") &&
        !document.querySelector<HTMLButtonElement>("#finish")?.disabled,
      { timeout: 180000 },
    );
    const preview = await previewImport(
      call,
      DEFAULT_TARGET,
      data.pack.entries,
    );
    assert.equal(preview.counts.existing, 2085);
    assert.equal(preview.counts.new, 0);
    const matched = await lookup(
      call,
      DEFAULT_TARGET,
      preview.rows.map((r) => r.key),
    );
    assert([...matched.values()].every((ids) => ids.length === 1));
    const withoutTags = await call("notes.search", {
      query: `note:"${DEFAULT_TARGET.noteType}" (-tag:voka or -tag:voka::level::B1)`,
    });
    assert.equal(withoutTags.ids.length, 0);
    const cardIds: string[] = [];
    let cardCursor: string | undefined;
    do {
      const cards = await call("cards.search", {
        query: `deck:"${DEFAULT_TARGET.deck}"`,
        limit: 1000,
        ...(cardCursor ? { cursor: cardCursor } : {}),
      });
      cardIds.push(...cards.ids);
      cardCursor = cards.nextCursor ?? undefined;
    } while (cardCursor);
    assert.equal(cardIds.length, 2085);
    result.checks["T-03"] = {
      count: 2085,
      cards: cardIds.length,
      estimateInSpec: 2088,
      defaultTarget: DEFAULT_TARGET,
      allKeysUnique: true,
      allTagsPresent: true,
    };
    const beforeRepeat = snapshot();
    const repeat = await executeImport(
      call,
      DEFAULT_TARGET,
      "native",
      "zh",
      data.pack.entries,
    );
    assert.equal(repeat.created, 0);
    assert.deepEqual(snapshot(), beforeRepeat);
    result.checks["T-04"] = {
      created: 0,
      allCardsAndReviewHistoryUnchanged: true,
    };
    await save();
    // Actual manual A2 add followed by the entire A2 import, with Key re-read.
    const a2 = data.pack.entries.find((e) => e.level === "A2")!;
    const key = "en:" + a2.lemma;
    const manual = await cardContext(
      call,
      {
        key,
        action: "save",
        text: `We discuss ${a2.lemma} in this clear example.`,
        html: `We discuss <b>${a2.lemma}</b> in this clear example.`,
        url: base,
        title: "P0 A2 manual",
      },
      config,
      async (k) => data.lookupEntry(k),
    );
    const a2Target = { ...DEFAULT_TARGET, deck: "VOKA::English::A2" };
    const a2Preview = await previewImport(call, a2Target, data.pack.entries);
    assert.equal(a2Preview.rows.find((r) => r.key === key)?.state, "existing");
    const a2Run = await executeImport(
      call,
      a2Target,
      "native",
      "zh",
      data.pack.entries,
    );
    assert.equal(a2Run.created, 1199);
    const manualIds = (await lookup(call, a2Target, [key])).get(key)!;
    assert.equal(manualIds.length, 1);
    const manualNote = (await call("notes.getMany", { ids: manualIds }))
      .items[0].result;
    assert.deepEqual(manualNote.fields, manual.fields);
    const manualCards = (
      await call("cards.getMany", { ids: manualNote.cardIds })
    ).items;
    assert(
      manualCards.every((i: any) => i.result.deck.name === "VOKA::English::A2"),
    );
    result.checks["T-06"] = {
      key,
      newBefore: 1199,
      existingBefore: 1,
      importCreated: a2Run.created,
      matchingNotes: manualIds,
      deck: "VOKA::English::A2",
    };
    await save();
    const page = await browser.newPage();
    const inject = async (url = base, ready = true) => {
      await page.goto(url);
      const id = await worker.evaluate(
        async (url) =>
          (await chrome.tabs.query({})).find(
            (t) => t.url === url + "/" || t.url === url,
          )!.id!,
        url,
      );
      await worker.evaluate(
        async (id) =>
          chrome.scripting.executeScript({
            target: { tabId: id },
            files: ["content.js"],
          }),
        id,
      );
      if (ready)
        await page.waitForFunction(
          () =>
            Number(
              document
                .getElementById("voka-drawer")
                ?.shadowRoot?.querySelector('[data-filter="all"]')
                ?.textContent?.match(/\d+$/)?.[0],
            ) > 0,
        );
      return id;
    };
    await inject();
    const highlights = () =>
      page.evaluate(() =>
        [...(CSS.highlights.get("voka-target") ?? [])].map((r) => r.toString()),
      );
    await page.waitForFunction(() =>
      [...(CSS.highlights.get("voka-target") ?? [])].some(
        (r) => r.toString() === "benefit",
      ),
    );
    await cardContext(
      call,
      {
        key: "en:benefit",
        action: "save",
        text: "We benefit from this clear example today.",
        html: "We <b>benefit</b> from this clear example today.",
        url: base,
        title: "P0 level switch",
      },
      config,
      async (key) => data.lookupEntry(key),
    );
    const beforeSwitch = snapshot();
    const notesBefore = (
      await lookup(call, DEFAULT_TARGET, ["en:benefit"])
    ).get("en:benefit")!;
    const noteBefore = await call("notes.getMany", { ids: notesBefore });
    const switches = [];
    for (const level of ["B1", "B2", "B1"]) {
      await worker.evaluate(
        (level) => chrome.storage.local.set({ targetLevel: level }),
        level,
      );
      await page.waitForFunction(
        (word) =>
          [...(CSS.highlights.get("voka-target") ?? [])].some(
            (r) => r.toString() === word,
          ),
        {},
        level === "B1" ? "benefit" : "abolish",
      );
      const ranges = await highlights();
      assert(ranges.includes(level === "B1" ? "benefit" : "abolish"));
      assert(!ranges.includes(level === "B1" ? "abolish" : "benefit"));
      switches.push({ level, ranges });
    }
    assert.deepEqual(snapshot(), beforeSwitch);
    assert.deepEqual(
      await call("notes.getMany", { ids: notesBefore }),
      noteBefore,
    );
    result.checks["T-07"] = {
      switches,
      allCardsAndRevlogUnchanged: true,
      benefitFieldsUnchanged: true,
    };
    await save();
    // Excluded regions cannot open a context-saving card on a double click.
    for (const id of ["input", "textarea", "editable", "code", "nav"]) {
      await page.locator("#" + id).click({ count: 2 });
      assert(
        await page.evaluate(
          () =>
            document
              .getElementById("voka-drawer")!
              .shadowRoot!.querySelector<HTMLElement>("#voka-card")!.hidden,
        ),
      );
    }
    const excludedRanges = await page.evaluate(() =>
      [...CSS.highlights].flatMap(([, ranges]) =>
        [...ranges]
          .filter((r) =>
            r.startContainer.parentElement?.closest(
              "input,textarea,[contenteditable],code,nav",
            ),
          )
          .map((r) => r.toString()),
      ),
    );
    assert.deepEqual(excludedRanges, []);
    result.checks["T-30"] = {
      regions: ["input", "textarea", "contenteditable", "code", "nav"],
      highlights: [],
      contextCardOpened: false,
    };
    const missing = data.pack.entries.find(
      (e) => data.lookupEntry(e.lemma).dictionaryStatus === "missing",
    )!;
    const unlevelled = data.lookupEntry("aardvark");
    assert.equal(unlevelled.level, "");
    assert.equal(unlevelled.dictionaryStatus, "found");
    await page.locator("#unlevelled").click({ count: 2 });
    await page.waitForFunction(() =>
      document
        .getElementById("voka-drawer")!
        .shadowRoot!.querySelector("#voka-card")
        ?.textContent?.includes("未分级"),
    );
    const ungradedCard = await page.evaluate(
      () =>
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelector("#voka-card")!.textContent,
    );
    assert(!ungradedCard?.includes("词典没有"));
    result.checks["T-11"] = {
      gradedMissing: missing,
      ungradedFound: unlevelled,
      ungradedCard,
    };
    // Render actual Anki cards in Chrome for Testing + Puppeteer (not mobile).
    const type = await call("noteTypes.get", {
      noteType: { name: DEFAULT_TARGET.noteType },
    });
    const userCss =
      type.css + "\n/* P0 user custom */\n.user-extra{color:rebeccapurple}";
    await call(
      "noteTypes.update",
      { noteType: { name: DEFAULT_TARGET.noteType }, patch: { css: userCss } },
      true,
    );
    const benefit = (await call("notes.getMany", { ids: notesBefore })).items[0]
      .result;
    const renderPage = await browser.newPage();
    const scmBefore = snapshot().scm;
    const modes = [];
    for (const mode of ["target", "native"] as const) {
      await options.select("#glossLanguage", mode);
      await options.waitForFunction(
        async (mode) =>
          (await chrome.storage.local.get("glossLanguage")).glossLanguage ===
          mode,
        {},
        mode,
      );
      let current: any;
      for (let i = 0; i < 50; i++) {
        current = await call("noteTypes.get", {
          noteType: { name: DEFAULT_TARGET.noteType },
        });
        if (current.css === replaceGlossCss(userCss, mode)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(current.css, replaceGlossCss(userCss, mode));
      assert.equal(snapshot().scm, scmBefore);
      const rendered = await call("cards.render", { id: benefit.cardIds[0] });
      await renderPage.setContent(
        `<style>${rendered.css}</style>${rendered.answerHtml}`,
      );
      const visible = await renderPage.evaluate(() => ({
        native: getComputedStyle(document.querySelector(".gloss-native")!)
          .display,
        target: getComputedStyle(document.querySelector(".gloss-target")!)
          .display,
      }));
      assert.equal(visible[mode], "block");
      assert.equal(visible[mode === "native" ? "target" : "native"], "none");
      await renderPage.screenshot({
        path: resolve(directory, mode + "-back.png"),
      });
      modes.push({ mode, scm: scmBefore, visible });
    }
    const fallbacks = [];
    for (const mode of ["native", "target"] as const) {
      const fields =
        mode === "native"
          ? { GlossNative: "", GlossTarget: "target fallback" }
          : { GlossNative: "母语回退", GlossTarget: "" };
      await call("notes.update", { id: benefit.id, patch: { fields } }, true);
      await call(
        "noteTypes.update",
        {
          noteType: { name: DEFAULT_TARGET.noteType },
          patch: { css: replaceGlossCss(userCss, mode) },
        },
        true,
      );
      const rendered = await call("cards.render", { id: benefit.cardIds[0] });
      assert(!rendered.css.includes(":has("));
      await renderPage.setContent(
        `<style>${rendered.css}</style>${rendered.answerHtml}`,
      );
      const shown = await renderPage.$eval(
        mode === "native" ? ".gloss-target" : ".gloss-native",
        (e) => ({ text: e.textContent, display: getComputedStyle(e).display }),
      );
      assert.equal(shown.display, "block");
      fallbacks.push({ mode, ...shown });
    }
    await call(
      "notes.update",
      { id: benefit.id, patch: { fields: benefit.fields } },
      true,
    );
    await call(
      "noteTypes.update",
      { noteType: { name: DEFAULT_TARGET.noteType }, patch: { css: type.css } },
      true,
    );
    result.checks["T-26"] = {
      modes,
      outsideCssPreserved: true,
      scmBefore,
      scmAfter: snapshot().scm,
      optionsControlsUsed: true,
    };
    result.checks["T-27"] = {
      fallbacks,
      noHas: true,
      browser: await browser.version(),
    };
    await save();
    // Built-in Gmail host, local fixture; grant uses Chrome's test UI backend.
    const extensions = await browser.newPage();
    await extensions.goto(`chrome://extensions/?id=${extensionId}`);
    await extensions.evaluate(
      async (id) =>
        chrome.developerPrivate.addHostPermission(id, "*://mail.google.com/*"),
      extensionId,
    );
    await options.evaluate(() => {
      const button = document.createElement("button");
      button.id = "p0-gmail-grant";
      button.textContent = "Grant fixture";
      button.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647";
      button.onclick = () => {
        chrome.permissions
          .request({ origins: ["*://mail.google.com/*"] })
          .then((granted) => {
            button.dataset.granted = String(granted);
          });
      };
      document.body.append(button);
    });
    await options.click("#p0-gmail-grant");
    await options.waitForFunction(
      () =>
        document.querySelector<HTMLElement>("#p0-gmail-grant")?.dataset
          .granted === "true",
    );
    await worker.evaluate(
      (denyList) =>
        chrome.storage.local.set({
          siteScope: "remembered",
          rememberedSites: ["mail.google.com"],
          denyList,
        }),
      [...DEFAULT_DENY_SITES],
    );
    // storage.onChanged reconciles registrations; the Gmail host stays denied.
    await new Promise((r) => setTimeout(r, 100));
    // Gmail is HSTS-preloaded. Fulfil its HTTPS URL from our local fixture
    // before transport; no Gmail service/account is contacted.
    const fixtureHtml = await (await fetch(base)).text();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (new URL(request.url()).hostname === "mail.google.com")
        void request.respond({
          status: 200,
          contentType: "text/html",
          body: fixtureHtml,
        });
      else void request.continue();
    });
    await page.goto(`https://mail.google.com:${port}/`);
    // waitForFunction defaults to rAF; it must observe a visible test tab.
    await page.bringToFront();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await page.$("#voka-drawer"), null);
    const gmailTab = await worker.evaluate(
      async () =>
        (await chrome.tabs.query({})).find((t) =>
          t.url?.includes("mail.google.com:"),
        )!.id!,
    );
    await worker.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          files: ["content.js"],
        }),
      gmailTab,
    );
    await page.waitForSelector("#voka-drawer");
    try {
      await page.waitForFunction(() =>
        [...(CSS.highlights.get("voka-target") ?? [])].some(
          (range) => range.toString() === "benefit",
        ),
      );
    } catch (error) {
      result.gmailFailure = await page.evaluate(() => ({
        url: location.href,
        ui: document.getElementById("voka-drawer")?.shadowRoot?.textContent,
        highlights: [...CSS.highlights].map(([key, ranges]) => ({
          key,
          words: [...ranges].map((range) => range.toString()),
        })),
      }));
      await page.screenshot({ path: resolve(directory, "gmail-failure.png") });
      await save();
      throw error;
    }
    await page.screenshot({
      path: resolve(directory, "gmail-local-manual.png"),
    });
    result.checks["T-31"] = {
      host: "mail.google.com",
      localFixture: true,
      fixtureDelivery:
        "CDP interception of HTTPS URL with HTML from local server",
      realGmail: false,
      autoRun: false,
      manualInjection: true,
      builtinDenyList: true,
      manualTargetHighlight: "benefit",
    };
    await save();
  } finally {
    await browser.close();
    server.close();
    if ((await checkConnection({ port: 8766, apiKey: "" })) === "unreachable") {
      const proc = spawn(
        resolve(process.env.HOME!, "VOKA-anki-test/launch.sh"),
        [],
        { detached: true, stdio: "ignore" },
      );
      proc.unref();
      for (
        let i = 0;
        i < 200 && (await checkConnection({ port: 8766, apiKey: "" })) !== "ok";
        i++
      )
        await new Promise((r) => setTimeout(r, 100));
    }
    // Retain fresh fixtures under unique names; restore all prior canonical names.
    if (
      (await call("noteTypes.list")).some(
        (t: any) => t.name === DEFAULT_TARGET.noteType,
      )
    )
      await call(
        "noteTypes.update",
        {
          noteType: { name: DEFAULT_TARGET.noteType },
          patch: { name: `VOKA P0 Final ${stamp}` },
        },
        true,
      );
    for (const deck of (await call("decks.list")).filter((d: any) =>
      /^VOKA::English::(A1|A2|B1|B2)$/.test(d.name),
    ))
      await call(
        "decks.update",
        {
          deck: { id: deck.id },
          name: `VOKA::P0 Final ${stamp}::${deck.name.split("::").at(-1)}`,
        },
        true,
      );
    if (originalType)
      await call(
        "noteTypes.update",
        {
          noteType: { id: originalType.id },
          patch: { name: originalType.name },
        },
        true,
      );
    for (const deck of originalDecks)
      await call(
        "decks.update",
        { deck: { id: deck.id }, name: deck.name },
        true,
      );
    result.retained = {
      noteType: `VOKA P0 Final ${stamp}`,
      deckPrefix: `VOKA::P0 Final ${stamp}`,
      priorCanonicalNamesRestored: true,
    };
    await save();
  }
}

async function permissionCheck(directory: string) {
  if (process.env.VOKA_NATIVE_PERMISSION !== "1") {
    await writeFile(
      resolve(directory, "results.json"),
      JSON.stringify(
        {
          result: "PARTIAL",
          limitation:
            "Real Anki permission Allow requires VOKA_NATIVE_PERMISSION=1 and local Orca accessibility; no configuration changed.",
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  assertNoAutomaticSync();
  const { checkConnection, rpc } = await import("../src/background/gateway.ts");
  const home = process.env.HOME!;
  const metaPath = resolve(
    home,
    "VOKA-anki-test/addons21/2055492159/meta.json",
  );
  const original = await readFile(metaPath, "utf8");
  const config = JSON.parse(original);
  assert.equal(config.config.webBindPort, 8766);
  const findPid = () => {
    const line = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .find((l) =>
        /\/Applications\/Anki\.app\/Contents\/MacOS\/Anki -b \/Users\/[^ ]+\/VOKA-anki-test(?: |$)/.test(
          l,
        ),
      );
    return line ? Number(line.trim().split(/\s+/)[0]) : undefined;
  };
  const stop = async () => {
    const pid = findPid();
    if (pid) process.kill(pid, "SIGTERM");
    for (let i = 0; i < 100 && findPid(); i++)
      await new Promise((r) => setTimeout(r, 100));
    assert(!findPid());
  };
  const start = async () => {
    const proc = spawn(resolve(home, "VOKA-anki-test/launch.sh"), [], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    for (let i = 0; i < 200; i++) {
      try {
        await rpc({ port: 8766, apiKey: "" }, "api.describe");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw Error("Isolated Anki failed to restart");
  };
  const result: any = {
    started: new Date().toISOString(),
    endpoint: "127.0.0.1:8766",
    nativePermission: "pending",
  };
  const save = () =>
    writeFile(
      resolve(directory, "results.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
  let browser: any;
  try {
    await stop();
    config.config.webCorsOriginList = [];
    await writeFile(metaPath, JSON.stringify(config, null, 2));
    await start();
    browser = await puppeteer.launch({
      headless: false,
      enableExtensions: [resolve("dist")],
      args: ["--no-first-run"],
    });
    const worker = (await (
      await browser.waitForTarget((t: any) => t.type() === "service_worker")
    ).worker())!;
    await worker.evaluate(() =>
      chrome.storage.local.set({ port: 8766, apiKey: "" }),
    );
    const id = worker.url().split("/")[2];
    const options = await browser.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.waitForFunction(
      () => !document.querySelector<HTMLElement>("#access")?.hidden,
    );
    await options.screenshot({
      path: resolve(directory, "forbidden.png"),
      fullPage: true,
    });
    const before = JSON.parse(
      execFileSync("python3", ["scripts/anki-snapshot.py"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    const audit = await options.createCDPSession();
    await audit.send("Network.enable");
    const methods: string[] = [];
    // Browser-wide network log is authoritative; this list covers Options requests only.
    audit.on("Network.requestWillBeSent", (event: any) => {
      if (event.request.url.includes(":8766/"))
        methods.push(event.request.postData || "");
    });
    await options.locator("#access").click();
    assert.deepEqual(
      JSON.parse(
        execFileSync("python3", ["scripts/anki-snapshot.py"], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      ),
      before,
    );
    result.noWritesBeforeAllow = true;
    const pid = findPid();
    assert(pid);
    result.pid = pid;
    result.origin = `chrome-extension://${id}`;
    result.beforeAllow = "forbidden, no import possible";
    await save();
    console.log("NATIVE_PERMISSION_PENDING", pid, result.origin);
    // Native dialog requires Orca's macOS accessibility provider. Set this flag
    // only in a supervised local acceptance run; otherwise retain PARTIAL.
    if (process.env.VOKA_NATIVE_PERMISSION === "1") {
      for (let i = 0; i < 120; i++) {
        const windows = JSON.parse(
          execFileSync(
            "orca",
            ["computer", "list-windows", "--app", `pid:${pid}`, "--json"],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
          ),
        );
        const dialog = windows.result?.windows?.find(
          (w: any) => w.title === "",
        );
        const selector = dialog ? ["--window-id", String(dialog.id)] : [];
        const state = JSON.parse(
          execFileSync(
            "orca",
            [
              "computer",
              "get-app-state",
              "--app",
              `pid:${pid}`,
              ...selector,
              "--json",
            ],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
          ),
        );
        const tree = state.result?.snapshot?.treeText || "";
        await writeFile(
          resolve(directory, "native-dialog.json"),
          JSON.stringify(state, null, 2),
        );
        if (state.result?.screenshot?.path)
          await cp(
            state.result.screenshot.path,
            resolve(directory, "native-dialog.png"),
          );
        const yes = tree.match(
          /^\s*(\d+) button (?:Yes|Allow|允许|是)(?:\s|$)/m,
        );
        if (
          yes &&
          tree.includes(result.origin) &&
          tree.includes("requests permission")
        ) {
          const action = JSON.parse(
            execFileSync(
              "orca",
              [
                "computer",
                "click",
                "--app",
                `pid:${pid}`,
                ...selector,
                "--element-index",
                yes[1],
                "--json",
              ],
              { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
            ),
          );
          await writeFile(
            resolve(directory, "native-allow.json"),
            JSON.stringify(action, null, 2),
          );
          result.nativePermission =
            "actual Anki dialog accepted through accessibility";
          break;
        }
        // In diagnostic runs the operator can accept the visible native dialog.
        if (
          JSON.parse(
            await readFile(metaPath, "utf8"),
          ).config.webCorsOriginList.includes(result.origin)
        ) {
          result.nativePermission = "actual Anki dialog accepted";
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } else {
      result.result = "PARTIAL";
      result.limitation =
        "Native Anki permission dialog requires VOKA_NATIVE_PERMISSION=1 and local Orca accessibility.";
      await save();
      return;
    }
    assert(
      result.nativePermission !== "pending",
      "native Anki Allow not confirmed",
    );
    await options.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#retry")?.disabled,
      { timeout: 120000 },
    );
    await options.locator("#retry").click();
    await options.waitForFunction(
      () => document.querySelector("#status")?.textContent === "已连接",
    );
    // A one-note throwaway write proves access after permission; never import a level.
    const target = {
      noteType: `VOKA P0 Permission ${Date.now()}`,
      deck: `VOKA::P0 Permission ${Date.now()}::B1`,
    };
    // tsx/esbuild inserts __name for nested functions serialized by Puppeteer.
    await worker.evaluate("globalThis.__name = (fn) => fn");
    const written = await worker.evaluate(async (target) => {
      let id = 0;
      const call = async (method: string, params: any = {}) => {
        const response = await fetch("http://127.0.0.1:8766/api/v1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        const body = await response.json();
        if (body.error) throw Error(JSON.stringify(body.error));
        return body.result;
      };
      await call("noteTypes.create", {
        name: target.noteType,
        fields: [{ name: "Key" }, { name: "Word" }],
        templates: [
          { name: "Card", questionHtml: "{{Word}}", answerHtml: "{{Key}}" },
        ],
      });
      await call("decks.create", { name: target.deck });
      const notes = [
        {
          noteType: { name: target.noteType },
          deck: { name: target.deck },
          fields: { Key: "en:permission-fixture", Word: "permission fixture" },
        },
      ];
      const valid = await call("notes.validateMany", { notes });
      if (!valid.items[0].result.valid) throw Error("invalid fixture");
      const created = await call("notes.createMany", { notes, atomic: false });
      const ids = [created.items[0].result.noteId];
      const readback = await call("notes.getMany", { ids });
      return { created: created.items.length, readback };
    }, target);
    assert.equal(written.created, 1);
    const after = JSON.parse(
      execFileSync("python3", ["scripts/anki-snapshot.py"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    assert.equal(after.cards.length, before.cards.length + 1);
    assert.deepEqual(after.revlog, before.revlog);
    result.result = "PASS";
    result.afterAllow = {
      connected: true,
      writes: written.created,
      target,
      readback: written.readback,
      existingReviewsUnchanged: true,
    };
    await save();
  } finally {
    if (browser) await browser.close();
    await stop();
    await writeFile(metaPath, original);
    await start();
    result.originalConfigRestored = true;
    await save();
  }
}

async function lifecycleCheck(directory: string) {
  assertNoAutomaticSync();
  const { checkConnection } = await import("../src/background/gateway.ts");
  assert.equal(await checkConnection({ port: 8766, apiKey: "" }), "ok");
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><title>P0 real disconnect fixture</title><p>We benefit from this clear example today.</p>",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  const browser = await puppeteer.launch({
    headless: false,
    enableExtensions: [resolve("dist")],
    args: ["--no-first-run"],
  });
  const restart = async () => {
    const proc = spawn(
      resolve(process.env.HOME!, "VOKA-anki-test/launch.sh"),
      [],
      { detached: true, stdio: "ignore" },
    );
    proc.unref();
    for (let i = 0; i < 200; i++) {
      if ((await checkConnection({ port: 8766, apiKey: "" })) === "ok") return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Isolated restart did not become ready");
  };
  const result: any = {
    date: new Date().toISOString(),
    port: 8766,
    freshProfile: true,
  };
  try {
    const worker = (await (
      await browser.waitForTarget((t) => t.type() === "service_worker")
    ).worker())!;
    await worker.evaluate(() =>
      chrome.storage.local.set({
        port: 8766,
        apiKey: "",
        targetLevel: "B1",
        siteScope: "activeTab",
      }),
    );
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 950 });
    const inject = async () => {
      await page.goto(url);
      const id = await worker.evaluate(
        async (url) =>
          (await chrome.tabs.query({})).find((t) => t.url === url)!.id!,
        url,
      );
      await worker.evaluate(
        async (id) =>
          chrome.scripting.executeScript({
            target: { tabId: id },
            files: ["content.js"],
          }),
        id,
      );
    };
    await inject();
    await page.waitForFunction(() =>
      [...(CSS.highlights.get("voka-target") ?? [])].some(
        (r) => r.toString() === "benefit",
      ),
    );
    const line = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
    })
      .split("\n")
      .find((l) =>
        /\/Applications\/Anki\.app\/Contents\/MacOS\/Anki -b \/Users\/[^ ]+\/VOKA-anki-test(?: |$)/.test(
          l,
        ),
      );
    assert(line);
    const pid = Number(line.trim().split(/\s+/)[0]);
    process.kill(pid, "SIGTERM");
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 200 && alive(); i++)
      await new Promise((r) => setTimeout(r, 100));
    assert(!alive(), "Isolated Anki process did not exit");
    assert.equal(
      await checkConnection({ port: 8766, apiKey: "" }),
      "unreachable",
    );
    await inject();
    await page.waitForFunction(
      () =>
        CSS.highlights.size === 0 &&
        /未运行|not running/i.test(
          document
            .getElementById("voka-drawer")
            ?.shadowRoot?.querySelector(".drawer-toggle [role=status]")
            ?.textContent || "",
        ),
    );
    await page.screenshot({ path: resolve(directory, "anki-stopped.png") });
    await restart();
    await page.evaluate(() =>
      Array.from(
        document
          .getElementById("voka-drawer")!
          .shadowRoot!.querySelectorAll("button"),
      )
        .find((b) => /重试|Retry/.test(b.textContent || ""))!
        .click(),
    );
    await page.waitForFunction(() =>
      [...(CSS.highlights.get("voka-target") ?? [])].some(
        (r) => r.toString() === "benefit",
      ),
    );
    await page.screenshot({ path: resolve(directory, "retry-restored.png") });
    Object.assign(result, {
      result: "PASS",
      terminatedPid: pid,
      isolatedProcessOnly: true,
      afterRefreshRanges: 0,
      promptShown: true,
      realRestart: true,
      retryRestoredHighlights: true,
    });
  } finally {
    if ((await checkConnection({ port: 8766, apiKey: "" })) === "unreachable")
      await restart();
    await browser.close();
    server.close();
    await writeFile(
      resolve(directory, "results.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
  }
}
