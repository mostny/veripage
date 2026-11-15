import { NextResponse, type NextRequest } from "next/server";
import { getReviewerConfig, reviewerToken, verifyReviewerSession } from "./lib/auth/reviewer.ts";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Auth endpoints validate their own requests. Only login and framework assets are public.
  if (pathname === "/api/auth/login" || pathname === "/api/auth/logout") return NextResponse.next();
  const config = getReviewerConfig();
  const loggedIn = config && await verifyReviewerSession(reviewerToken(request), config);
  if (pathname === "/login") {
    if (loggedIn) return NextResponse.redirect(new URL("/", config.origin));
    return NextResponse.next();
  }
  // API handlers return JSON errors and recheck authorization before doing any work.
  if (pathname.startsWith("/api/")) return NextResponse.next();
  const response = loggedIn
    ? NextResponse.next()
    : NextResponse.redirect(new URL("/login", config?.origin ?? request.url));
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static/|_next/image|favicon.ico$).*)"],
};
