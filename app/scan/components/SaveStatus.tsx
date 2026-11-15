"use client";

import { useState } from "react";
import Link from "next/link";
import type { CaseSaveState } from "@/lib/cases/types";

export function SaveStatus({ state, onRetry, onDelete }: {
  state: CaseSaveState;
  onRetry: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const retention = state.status === "saved" ? state.record.retention : [];
  const missing = retention.filter((item) => item.state === "missing").length;
  const saved = retention.filter((item) => item.state === "saved").length;
  const title = state.status === "saving" ? "正在保存到本机…"
    : state.status === "saved" ? (missing ? "已保存报告，证据不完整" : "已保存到本机")
      : state.status === "error" ? "保存失败"
        : state.status === "deleted" ? "本机副本已清除" : "本次报告尚未保存到本机";

  async function remove() {
    setDeleting(true);
    setDeleteError("");
    try { await onDelete(); }
    catch { setDeleteError("清除失败，本机副本可能仍在，请重试。"); }
    finally { setDeleting(false); }
  }

  return (
    <section aria-label="本地保存状态" aria-live="polite" className="rounded-xl border border-line bg-white px-4 py-3">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-line text-[10px] text-ink-soft">i</span>
        <div>
          <p className="text-xs font-medium text-ink-soft">{title}</p>
          <p className="mt-1 text-xs leading-5 text-ink-soft">
            {state.status === "saved" ? `报告与 ${saved} 张截图已写入当前浏览器${missing ? `，${missing} 项截图未取回` : ""}。清理站点数据可能丢失记录。`
              : state.status === "error" ? `${state.message} 当前报告仍可查看；已存在的副本不受失败事务覆盖。`
                : state.status === "deleted" ? "当前报告仍可查看，可重新保存。"
                  : "分析结果已可查看，本机保存单独进行，不影响风险判断。"}
          </p>
          {state.status === "saved" && <>
            <ul className="mt-1 text-xs leading-5 text-amber-800">{retention.filter((item) => item.state !== "saved").map((item) => <li key={item.artifactId}>{item.state === "missing" ? "未取回：" : "有意省略："}{item.reason}</li>)}</ul>
            <Link href={`/cases/${encodeURIComponent(state.record.id)}`} className="mt-2 inline-block rounded text-xs text-blue-600 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">查看本机快照</Link>
          </>}
          {deleteError && <p role="alert" className="mt-2 text-xs text-rose-700">{deleteError}</p>}
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {(state.status === "error" || state.status === "deleted" || (state.status === "saved" && missing > 0)) && <button type="button" disabled={deleting} onClick={() => { setDeleteError(""); onRetry(); }} className="rounded border border-blue-200 px-2.5 py-1.5 text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40">{state.status === "deleted" ? "重新保存到本机" : "重试保存"}</button>}
            {(state.status === "saved" || state.status === "error") && <button type="button" disabled={deleting} onClick={() => void remove()} className="rounded border border-line px-2.5 py-1.5 text-ink-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40">{deleting ? "清除中…" : "清除本机副本"}</button>}
          </div>
        </div>
      </div>
    </section>
  );
}
