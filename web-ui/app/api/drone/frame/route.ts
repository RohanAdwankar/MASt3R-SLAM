import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const DRONE_PROJECT = "/Users/rohanadwankar/drone";

const CAPTURE_SCRIPT = `
from nimbusos_sdk import NimbusClient

with NimbusClient() as client:
    frame = next(client.camera_frames(timeout_sec=3.0, receive_hwm=1))
    print(frame.jpeg.hex(), end="")
`;

export async function GET() {
  try {
    const { stdout } = await execFileAsync(
      "uv",
      ["run", "--project", DRONE_PROJECT, "python", "-c", CAPTURE_SCRIPT],
      {
        maxBuffer: 1024 * 1024 * 8,
        timeout: 6000,
      },
    );
    const jpeg = Buffer.from(stdout.trim(), "hex");
    return new Response(jpeg, {
      headers: {
        "cache-control": "no-store",
        "content-type": "image/jpeg",
      },
    });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Failed to read drone camera",
      { status: 502 },
    );
  }
}
