/** Test-only credentials and signed session; no production config or real endpoint is loaded. */
import { createReviewerSession, hashReviewerPassword, REVIEWER_COOKIE, type ReviewerConfig } from "../lib/auth/reviewer.ts";

export async function installReviewerFixture(origin = "https://veripage.local") {
  const config: ReviewerConfig = {
    username: "offline-reviewer",
    passwordHash: await hashReviewerPassword("offline-test-password-not-a-real-credential"),
    sessionSecret: "offline-session-signing-key-not-a-real-secret",
    origin,
  };
  const vars = {
    VERIPAGE_REVIEWER_USERNAME: config.username,
    VERIPAGE_REVIEWER_PASSWORD_HASH: config.passwordHash,
    VERIPAGE_SESSION_SECRET: config.sessionSecret,
    VERIPAGE_PUBLIC_ORIGIN: config.origin,
  };
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  const cookie = `${REVIEWER_COOKIE}=${await createReviewerSession(config)}`;
  return {
    config,
    cookie,
    headers: { cookie, origin },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
