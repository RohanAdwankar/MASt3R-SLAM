import { promises as fs } from "fs";
import path from "path";

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ sceneId: string }> },
) {
  const { sceneId } = await context.params;
  const plyPath = path.join(repoRoot(), "logs", "web-ui", sceneId, "frames.ply");

  try {
    const file = await fs.readFile(plyPath);
    return new Response(file, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("Scene not found", { status: 404 });
  }
}
