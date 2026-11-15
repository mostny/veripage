"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { CaseDetail } from "../CaseDetail";

function CaseRoute() {
  const { id } = useParams<{ id: string }>();
  return <CaseDetail key={id} id={id} />;
}

export default function CasePage() {
  return <Suspense fallback={<main className="min-h-screen bg-paper p-8 text-sm text-ink-soft">正在读取本机快照…</main>}><CaseRoute /></Suspense>;
}
