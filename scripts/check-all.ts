import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const checkScripts = [
  "check:anki",
  "check:import",
  "check:level-import",
  "check:highlight",
  "check:manual",
  "check:dynamic",
  "check:contexts",
  "check:scope",
  "check:gloss-upgrade",
  "check:due",
  "check:review",
  "check:practice",
  "check:p1",
  "check:epub",
  "check:pdf",
  "check:youtube",
  "check:p0",
];

type CheckResult = {
  name: string;
  status: "PASS" | "FAIL" | "MISSING";
  exitCode: number | null;
  durationMs: number;
  outputLines: string[];
  signal?: string;
};

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const logDirectory = resolve(root, ".cache/check-all");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const packageScripts = packageJson.scripts ?? {};
const commands = ["build", ...checkScripts];
const results: CheckResult[] = [];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

await mkdir(logDirectory, { recursive: true });

function keepLastLines(lines: string[], line: string) {
  lines.push(line);
  if (lines.length > 15) lines.splice(0, lines.length - 15);
}

async function writeLog(result: CheckResult) {
  const lines = [
    `command: npm run ${result.name}`,
    `status: ${result.status}`,
    `exit code: ${result.exitCode === null ? "missing" : result.exitCode}`,
    `duration: ${result.durationMs}ms`,
  ];
  if (result.signal) lines.push(`signal: ${result.signal}`);
  lines.push("last 15 output lines:");
  lines.push(...(result.outputLines.length ? result.outputLines : ["(no output)"]));
  await writeFile(resolve(logDirectory, `${result.name.replaceAll(":", "-")}.log`), `${lines.join("\n")}\n`);
}

async function runScript(name: string): Promise<CheckResult> {
  if (!Object.hasOwn(packageScripts, name)) {
    const missing: CheckResult = {
      name,
      status: "MISSING",
      exitCode: null,
      durationMs: 0,
      outputLines: [],
    };
    await writeLog(missing);
    return missing;
  }

  const startedAt = performance.now();
  const outputLines: string[] = [];
  let pendingLine = "";
  let spawnError: string | undefined;
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  const append = (text: string) => {
    const split = `${pendingLine}${text}`.split("\n");
    pendingLine = split.pop() ?? "";
    for (const line of split) keepLastLines(outputLines, line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  console.log(`\n>>> npm run ${name}`);
  const child = spawn(npm, ["run", name], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    append(stdoutDecoder.write(chunk));
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    append(stderrDecoder.write(chunk));
    process.stderr.write(chunk);
  });
  child.on("error", (error) => {
    spawnError = error.message;
    keepLastLines(outputLines, `spawn error: ${error.message}`);
  });

  const completion = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
    child.on("close", (code, signal) => resolveClose({ code, signal }));
  });

  append(stdoutDecoder.end());
  append(stderrDecoder.end());
  if (pendingLine) keepLastLines(outputLines, pendingLine);
  const durationMs = Math.round(performance.now() - startedAt);
  const exitCode = completion.code ?? (spawnError || completion.signal ? 1 : 0);
  const result: CheckResult = {
    name,
    status: exitCode === 0 ? "PASS" : "FAIL",
    exitCode,
    durationMs,
    outputLines,
    ...(completion.signal ? { signal: completion.signal } : {}),
  };
  await writeLog(result);
  return result;
}

for (const name of commands) results.push(await runScript(name));

const widths = {
  name: Math.max("Script".length, ...results.map(({ name }) => name.length)),
  status: Math.max("Status".length, ...results.map(({ status }) => status.length)),
  exit: "Exit code".length,
  duration: "Duration".length,
};
const row = (name: string, status: string, exit: string, duration: string) =>
  `| ${name.padEnd(widths.name)} | ${status.padEnd(widths.status)} | ${exit.padStart(widths.exit)} | ${duration.padStart(widths.duration)} |`;
const table = [
  row("Script", "Status", "Exit code", "Duration"),
  `| ${"-".repeat(widths.name)} | ${"-".repeat(widths.status)} | ${"-".repeat(widths.exit)} | ${"-".repeat(widths.duration)} |`,
  ...results.map((result) =>
    row(
      result.name,
      result.status,
      result.exitCode === null ? "—" : String(result.exitCode),
      `${(result.durationMs / 1000).toFixed(1)}s`,
    ),
  ),
];

console.log("\ncheck:all summary");
console.log(table.join("\n"));
console.log(`Logs: ${logDirectory}`);

if (results.some(({ status }) => status !== "PASS")) process.exitCode = 1;
