"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

interface ScanInput {
  targetUrl: string;
  setTargetUrl: (url: string) => void;
}

const ScanInputContext = createContext<ScanInput | null>(null);

/** Root-layout-local handoff: never serialized into a route or browser storage. */
export function ScanInputProvider({ children }: { children: ReactNode }) {
  const [targetUrl, setTargetUrl] = useState("");
  const pathname = usePathname();
  const previousPathname = useRef(pathname);

  useEffect(() => {
    if (previousPathname.current === "/scan" && pathname !== "/scan") setTargetUrl("");
    previousPathname.current = pathname;
  }, [pathname]);

  return <ScanInputContext.Provider value={{ targetUrl, setTargetUrl }}>{children}</ScanInputContext.Provider>;
}

/** Both consumers are children of ScanInputProvider in the root layout. */
export function useScanInput() {
  return useContext(ScanInputContext)!;
}
