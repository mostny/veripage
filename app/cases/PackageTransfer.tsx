"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { createCasePackage, importCasePackage } from "@/lib/cases/package";

export function CaseExport({ caseId }: { caseId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function download() {
    if (!window.confirm("案例包可能包含敏感截图、模型结论和个人复核理由。原始 URL 取证副本默认不导出，其他内容仍请人工复核。确认生成下载？")) return;
    setBusy(true);
    setMessage("");
    try {
      const file = await createCasePackage(caseId);
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `veripage-case-${caseId}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage("案例包已生成，请查看浏览器下载；分享前复核敏感内容。");
    } catch (error) { setMessage(`导出失败：${error instanceof Error ? error.message : "本机数据暂不可用"}`); }
    finally { setBusy(false); }
  }

  return <section aria-label="导出案例包" className="mb-4 rounded-xl border border-line bg-white p-4 text-xs leading-6 text-ink-soft"><div className="flex flex-wrap items-center justify-between gap-3"><p>单案例 JSON 包包含原判、已保留 PNG 与按提交顺序排列的个人意见。文件不加密，分享前请复核。</p><button type="button" disabled={busy} onClick={() => void download()} className="rounded-lg border border-blue-200 px-3 py-2 text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-40">{busy ? "正在生成…" : "导出案例包"}</button></div>{message && <p role="status" className="mt-2 text-ink">{message}</p>}</section>;
}

type ImportState = { status: "idle" | "working" } | { status: "error"; message: string } | { status: "done"; caseId: string };

export function CaseImport({ onImported }: { onImported: () => void }) {
  const inputId = useId();
  const [state, setState] = useState<ImportState>({ status: "idle" });

  async function read(file: File) {
    setState({ status: "working" });
    try {
      const caseId = await importCasePackage(file);
      setState({ status: "done", caseId });
      onImported();
    } catch (error) { setState({ status: "error", message: error instanceof Error ? error.message : "导入失败，原有数据未改变" }); }
  }

  return <section aria-label="导入案例包" className="mb-4 rounded-xl border border-line bg-white p-4 text-xs leading-6 text-ink-soft"><label htmlFor={inputId} className="block font-semibold text-ink">导入案例包</label><p className="mt-1">仅在本机校验和保存 ≤16 MiB 的 veripage-case v1 JSON；已有编号拒绝覆盖，不执行 HTML 或远程资源。校验只检查结构，文件来源与结论真实性仍需自行核实。</p><input id={inputId} type="file" accept=".json,application/json" disabled={state.status === "working"} onChange={(event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void read(file);
  }} className="mt-3 block w-full min-w-0 rounded text-xs text-ink-soft file:mr-3 file:rounded file:border file:border-line file:bg-slate-50 file:px-3 file:py-2 file:text-ink focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-40" />{state.status === "working" && <p role="status" className="mt-2">正在校验并导入…</p>}{state.status === "error" && <p role="alert" className="mt-2 text-amber-800">{state.message}</p>}{state.status === "done" && <p role="status" className="mt-2 text-blue-700">已导入本机案例。<Link href={`/cases/${encodeURIComponent(state.caseId)}`} className="ml-2 rounded underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-blue-400">查看导入快照</Link></p>}</section>;
}
