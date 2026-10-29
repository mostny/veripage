import { artifactCookieName, artifactStore, isArtifactUuid } from "../../../../../../lib/artifacts/store.ts";

function noStoreHeaders(): Headers {
  return new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  });
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function notFound(): Response {
  return new Response("Temporary evidence is unavailable.", {
    status: 404,
    headers: noStoreHeaders(),
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; artifactId: string }> },
): Promise<Response> {
  const { id, artifactId } = await context.params;
  if (!isArtifactUuid(id) || !isArtifactUuid(artifactId)) return notFound();
  const token = readCookie(request, artifactCookieName(id));
  if (!token) return notFound();

  try {
    const artifact = await artifactStore.get(id, token, artifactId);
    if (!artifact) return notFound();
    const headers = noStoreHeaders();
    headers.set("Content-Type", artifact.mediaType);
    headers.set("Content-Length", String(artifact.byteLength));
    headers.set("Content-Disposition", 'inline; filename="evidence.png"');
    const body = new Uint8Array(artifact.bytes.byteLength);
    body.set(artifact.bytes);
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response("Temporary evidence could not be loaded.", {
      status: 500,
      headers: noStoreHeaders(),
    });
  }
}
