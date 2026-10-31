/** Manual judgments are stored in Anki and beat every automatic highlight rule. */
export type ManualStatus = "" | "known" | "unknown";
export type ManualAction = { status: ManualStatus; label: string };
export function parseManualStatus(value: unknown): ManualStatus | undefined {
  return value === "" || value === "known" || value === "unknown"
    ? value
    : undefined;
}
/** `highlighted` is the current automatic/manual style, before this click. */
export function manualAction(
  status: string | undefined,
  highlighted: boolean,
): ManualAction {
  if (status === "known" || status === "unknown")
    return { status: "", label: "撤销标记" };
  return highlighted
    ? { status: "known", label: "我认识，别再高亮" }
    : { status: "unknown", label: "我不认识，高亮它" };
}
