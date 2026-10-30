export function SaveStatus() {
  return (
    <section aria-label="本地保存状态" className="rounded-xl border border-white/10 bg-slate-900/45 px-4 py-3">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-slate-400/20 text-[10px] text-slate-400">i</span>
        <div>
          <p className="text-xs font-medium text-slate-300">本次报告尚未保存到本机</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">当前结果只在本页临时展示；刷新或关闭页面后无法回看。案例保存与个人复核在后续阶段接入。</p>
        </div>
      </div>
    </section>
  );
}
