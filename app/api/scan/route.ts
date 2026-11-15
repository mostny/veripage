import { runScan } from "../../../lib/agent/orchestrator.ts";
import { handleScanPost } from "../../../lib/scans/handler.ts";
import { authorizeReviewerRequest } from "../../../lib/auth/reviewer.ts";

export async function POST(request: Request): Promise<Response> {
  const denied = await authorizeReviewerRequest(request);
  if (denied) return denied;
  return handleScanPost(request, {
    runScan: (url, onEvent, context) => runScan(url, onEvent, {
      signal: context.signal,
      artifactSession: { taskId: context.taskId, token: context.sessionToken },
    }),
  });
}
