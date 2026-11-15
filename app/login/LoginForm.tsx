"use client";

import { useState, type FormEvent } from "react";

export default function LoginForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const formData = new FormData(event.currentTarget);
    setPending(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: formData.get("username"),
          password: formData.get("password"),
        }),
      });
      const result: { ok?: boolean; error?: string } = await response.json();

      if (!response.ok || result.ok !== true) {
        setError(result.error || "登录失败，请稍后重试。");
        setPending(false);
        return;
      }

      window.location.replace("/");
    } catch {
      setError("暂时无法登录，请检查网络后重试。");
      setPending(false);
    }
  }

  return (
    <form onSubmit={login} aria-busy={pending} className="mt-7 space-y-5">
      <div>
        <label htmlFor="reviewer-username" className="mb-2 block text-sm font-medium">
          用户名
        </label>
        <input
          id="reviewer-username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={pending}
          className="w-full min-w-0 rounded-lg border border-line bg-white px-3 py-2.5 text-base text-ink outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
        />
      </div>
      <div>
        <label htmlFor="reviewer-password" className="mb-2 block text-sm font-medium">
          密码
        </label>
        <input
          id="reviewer-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          className="w-full min-w-0 rounded-lg border border-line bg-white px-3 py-2.5 text-base text-ink outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
        />
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-line bg-paper px-3 py-2.5 text-sm leading-6 text-ink">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "正在登录…" : "登录"}
      </button>
    </form>
  );
}
