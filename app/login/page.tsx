import type { Metadata } from "next";
import LoginForm from "./LoginForm";

export const metadata: Metadata = {
  title: "评测登录 · 网鉴 VeriPage",
};

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-paper px-5 py-12 text-ink">
      <div className="w-full max-w-md">
        <div className="mb-7 text-center text-lg font-semibold tracking-tight">
          网鉴 <span className="text-blue-600">VeriPage</span>
        </div>
        <section
          aria-labelledby="login-title"
          className="rounded-xl border border-line bg-white p-6 sm:p-8"
        >
          <h1 id="login-title" className="text-2xl font-bold tracking-tight">
            评测登录
          </h1>
          <p className="mt-3 text-sm leading-6 text-ink-soft">
            使用提供的测试账号进入网鉴 VeriPage。此环境仅供受邀评测。
          </p>
          <LoginForm />
        </section>
      </div>
    </main>
  );
}
