import { runScan } from "../../../lib/agent/orchestrator.ts";
import { handleScanPost } from "../../../lib/scans/handler.ts";

export async function POST(request: Request): Promise<Response> {
  return handleScanPost(request, {
    runScan: (url, onEvent, context) => runScan(url, onEvent, {
      signal: context.signal,
      artifactSession: { taskId: context.taskId, token: context.sessionToken },
    }),
  });
}
