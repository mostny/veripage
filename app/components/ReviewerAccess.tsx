"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

export default function ReviewerAccess() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  if (pathname === "/login") return null;

  async function logout() {
    if (pending) return;
    setPending(true);
    setError("");

    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      const result: { ok?: boolean; error?: string } = await response.json();

      if (!response.ok || result.ok !== true) {
        setError(result.error || "退出失败，请稍后重试。");
        setPending(false);
        return;
      }

      window.location.replace("/login");
    } catch {
      setError("暂时无法退出，请检查网络后重试。");
      setPending(false);
    }
  }

  return (
    <header aria-label="评测访问" className="w-full border-b border-line bg-white px-4 py-2 text-xs text-ink-soft sm:px-6">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="leading-5">评测演示 · 登录有效期 12 小时</p>
        <button
          type="button"
          onClick={logout}
          disabled={pending}
          aria-busy={pending}
          className="shrink-0 rounded-md border border-line px-3 py-2 font-medium text-ink transition hover:border-blue-300 hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-wait disabled:opacity-60"
        >
          {pending ? "正在退出…" : "退出"}
        </button>
        {error && <p role="alert" className="w-full leading-5 text-ink">{error}</p>}
      </div>
    </header>
  );
}
