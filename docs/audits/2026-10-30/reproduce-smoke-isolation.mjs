/**
 * Demonstrates the pre-stub model path in text-line.smoke.ts without networking.
 * The imported smoke exits this child process itself. Run as a standalone command.
 */
process.env.VERIPAGE_AGNES_BASE_URL = "https://audit.invalid/v1";
process.env.VERIPAGE_AGNES_API_KEY = "audit-fixture-not-a-real-credential";

let callsBeforeSuiteStub = 0;
globalThis.fetch = async () => {
  callsBeforeSuiteStub += 1;
  console.log(`AUDIT_BLOCKED_UNSTUBBED_FETCH=${callsBeforeSuiteStub}`);
  return new Response("Blocked by audit: no network was performed.", { status: 400 });
};

process.on("exit", () => {
  console.log(`AUDIT_PRE_STUB_MODEL_CALLS=${callsBeforeSuiteStub}`);
});

await import("../../../eval/text-line.smoke.ts");
