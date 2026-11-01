import { t } from "./shared";
import type { UpgradePreview, UpgradeResult } from "./background/upgrade";
export function mountUpgrade(box: HTMLElement, status: HTMLElement) {
  let busy = false;
  chrome.runtime.onMessage.addListener((message) => {
    if (busy && message?.type === "upgrade-progress") {
      const p = message.data as UpgradeResult;
      status.textContent = `${t("upgradeProgress")} ${p.processed}/${p.total}`;
    }
  });
  async function preview() {
    if (busy) return;
    busy = true;
    box.replaceChildren();
    status.textContent = t("upgradeChecking");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "preview-upgrade",
      });
      if (response.error) throw new Error(response.error);
      const p = response.data as UpgradePreview & { token: string };
      const inputs: HTMLInputElement[] = [];
      const summary = document.createElement("p");
      summary.textContent = `${t("upgradeCount").replace("{count}", String(p.rows.length))} · ${p.version}`;
      box.append(summary);
      for (const edited of [false, true]) {
        const group = document.createElement("details");
        group.open = edited;
        const title = document.createElement("summary");
        const rows = p.rows.filter((r) => r.edited === edited);
        title.textContent = `${t(edited ? "upgradeEdited" : "upgradeUnedited")} · ${rows.length}`;
        group.append(title);
        const groupInputs: HTMLInputElement[] = [];
        for (const [key, checked] of [
          ["upgradeUseAll", true],
          ["upgradeKeepAll", false],
        ] as const) {
          const button = document.createElement("button");
          button.textContent = t(key);
          button.onclick = () =>
            groupInputs.forEach((i) => {
              i.checked = checked;
            });
          group.append(button);
        }
        for (const row of rows) {
          const article = document.createElement("article");
          const label = document.createElement("label");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.dataset.id = row.id;
          input.checked = !edited;
          label.append(input, `${row.key} · ${t("upgradeUseNew")}`);
          groupInputs.push(input);
          inputs.push(input);
          article.append(label);
          const compare = document.createElement("div");
          compare.style.cssText =
            "display:grid;grid-template-columns:1fr 1fr;gap:16px;overflow-wrap:anywhere";
          for (const [key, fields] of [
            ["upgradeYours", row.current],
            ["upgradeNew", row.next],
          ] as const) {
            const pre = document.createElement("pre");
            pre.textContent = `${t(key)}\n${Object.entries(fields)
              .map(([f, v]) => `${f}: ${v}`)
              .join("\n")}`;
            compare.append(pre);
          }
          article.append(compare);
          group.append(article);
        }
        box.append(group);
      }
      const confirm = document.createElement("button");
      confirm.id = "confirmUpgrade";
      confirm.textContent = t("upgradeConfirm");
      confirm.disabled = !p.rows.length;
      confirm.onclick = async () => {
        if (busy) return;
        busy = true;
        // Freeze the concrete choices while the background processes them.
        const selected = inputs
          .filter((i) => i.checked)
          .map((i) => i.dataset.id!);
        box
          .querySelectorAll<HTMLButtonElement | HTMLInputElement>(
            "button,input",
          )
          .forEach((e) => {
            e.disabled = true;
          });
        try {
          const result = await chrome.runtime.sendMessage({
            type: "execute-upgrade",
            token: p.token,
            selected,
          });
          if (result.error) throw new Error(result.error);
          const data = result.data as UpgradeResult;
          status.textContent =
            `${t("upgradeFinished")} ${data.results.filter((r) => r.status === "updated").length}/${data.total}\n` +
            data.results
              .map(
                (r) =>
                  `${r.key}: ${r.status}${r.reason ? " · " + r.reason : ""}`,
              )
              .join("\n");
        } catch (error) {
          status.textContent = String(error);
        } finally {
          busy = false;
        }
      };
      box.append(confirm);
      status.textContent = p.failures
        .map((f) => `${f.id}: ${f.reason}`)
        .join("\n");
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy = false;
    }
  }
  return { preview };
}
