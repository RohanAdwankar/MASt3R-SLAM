import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function makeSceneId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function countPoints(plyPath: string) {
  const handle = await fs.open(plyPath, "r");
  const buffer = Buffer.alloc(4096);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  await handle.close();

  const header = buffer.subarray(0, bytesRead).toString("utf8");
  const match = header.match(/element vertex (\d+)/);
  if (!match) {
    throw new Error("Failed to read vertex count from reconstruction");
  }
  return Number(match[1]);
}

export async function POST(request: Request) {
  const data = await request.formData();
  const uploads = data.getAll("frames");
  if (uploads.length < 2) {
    return new Response("Need at least two frames", { status: 400 });
  }

  const root = repoRoot();
  const sceneId = makeSceneId();
  const frameDir = path.join(root, "tmp", "web-ui", sceneId, "frames");
  const logDir = path.join(root, "logs", "web-ui", sceneId);

  await fs.mkdir(frameDir, { recursive: true });

  for (const [index, upload] of uploads.entries()) {
    if (!(upload instanceof File)) {
      return new Response("Invalid frame payload", { status: 400 });
    }
    const output = path.join(frameDir, `${String(index).padStart(6, "0")}.png`);
    const bytes = Buffer.from(await upload.arrayBuffer());
    await fs.writeFile(output, bytes);
  }

  try {
    await execFileAsync(
      "/bin/zsh",
      [
        "-lc",
        `cd ${JSON.stringify(root)} && DEVELOPER_DIR=/Library/Developer/CommandLineTools uv run python main.py --dataset ${JSON.stringify(frameDir)} --config config/base.yaml --save-as ${JSON.stringify(path.join("web-ui", sceneId))} --no-viz`,
      ],
      {
        maxBuffer: 1024 * 1024 * 20,
      },
    );
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Reconstruction failed",
      { status: 500 },
    );
  }

  const plyPath = path.join(logDir, "frames.ply");
  const pointCount = await countPoints(plyPath);

  return Response.json({
    sceneId,
    plyUrl: `/api/scenes/${sceneId}/ply`,
    pointCount,
  });
}
