"use client";

import { useEffect, useRef, useState } from "react";
import { SceneViewer } from "./scene-viewer";

type RecordingFrame = {
  blob: Blob;
  url: string;
};

type SceneResult = {
  sceneId: string;
  plyUrl: string;
  pointCount: number;
};

type CameraSource = "laptop" | "drone";
type FlipAxis = "none" | "x" | "y" | "z";

const CAPTURE_INTERVAL_MS = 350;
const DEFAULT_RECENT_FRAME_LIMIT = "0";
const DEFAULT_BUILD_INTERVAL_SECONDS = "5";
const DEFAULT_BUILD_FRAMES_PER_SECOND = "2";
const DEFAULT_MAX_BUILD_GROWTH = "3";

function captureFrame(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create frame context");
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to encode frame"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

export function DemoApp() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const framesRef = useRef<RecordingFrame[]>([]);
  const recordingRef = useRef(false);
  const liveBusyRef = useRef(false);
  const capturingRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  const nextLiveBuildAtRef = useRef(0);
  const dronePreviewUrlRef = useRef<string | null>(null);
  const liveSettingsRef = useRef({
    liveBuild: true,
    buildIntervalSeconds: DEFAULT_BUILD_INTERVAL_SECONDS,
    buildFramesPerSecond: DEFAULT_BUILD_FRAMES_PER_SECOND,
    maxBuildGrowth: DEFAULT_MAX_BUILD_GROWTH,
  });

  const [frames, setFrames] = useState<RecordingFrame[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveBuild, setLiveBuild] = useState(true);
  const [cameraSource, setCameraSource] = useState<CameraSource>("laptop");
  const [flipAxis, setFlipAxis] = useState<FlipAxis>("y");
  const [recentFrameLimit, setRecentFrameLimit] = useState(DEFAULT_RECENT_FRAME_LIMIT);
  const [buildIntervalSeconds, setBuildIntervalSeconds] = useState(
    DEFAULT_BUILD_INTERVAL_SECONDS,
  );
  const [buildFramesPerSecond, setBuildFramesPerSecond] = useState(
    DEFAULT_BUILD_FRAMES_PER_SECOND,
  );
  const [maxBuildGrowth, setMaxBuildGrowth] = useState(DEFAULT_MAX_BUILD_GROWTH);
  const [dronePreviewUrl, setDronePreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("Camera idle");
  const [scene, setScene] = useState<SceneResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  liveSettingsRef.current = {
    liveBuild,
    buildIntervalSeconds,
    buildFramesPerSecond,
    maxBuildGrowth,
  };

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
      }
      for (const frame of framesRef.current) {
        URL.revokeObjectURL(frame.url);
      }
      if (dronePreviewUrlRef.current) {
        URL.revokeObjectURL(dronePreviewUrlRef.current);
      }
    };
  }, []);

  async function ensureCamera() {
    if (streamRef.current) {
      return streamRef.current;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "environment",
      },
      audio: false,
    });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    return stream;
  }

  async function captureDroneFrame() {
    const response = await fetch("/api/drone/frame", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    dronePreviewUrlRef.current = url;
    setDronePreviewUrl((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous);
      }
      return url;
    });
    return { blob, url };
  }

  function resetFrames() {
    for (const frame of framesRef.current) {
      URL.revokeObjectURL(frame.url);
    }
    framesRef.current = [];
    setFrames([]);
  }

  function stopLaptopCamera() {
    if (!streamRef.current) {
      return;
    }
    for (const track of streamRef.current.getTracks()) {
      track.stop();
    }
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  function appendFrame(frame: RecordingFrame) {
    const parsedLimit = Number.parseInt(recentFrameLimit, 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 0;
    const nextFrames = [...framesRef.current, frame];
    const keptFrames = limit > 0 ? nextFrames.slice(-limit) : nextFrames;
    const droppedFrames = nextFrames.slice(0, nextFrames.length - keptFrames.length);
    for (const droppedFrame of droppedFrames) {
      URL.revokeObjectURL(droppedFrame.url);
    }
    framesRef.current = keptFrames;
    setFrames(keptFrames);
    maybeLiveReconstruct();
  }

  function numericSetting(value: string, fallback: number) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function liveBuildFrameBudget(elapsedSeconds: number) {
    const settings = liveSettingsRef.current;
    const intervalSeconds = numericSetting(settings.buildIntervalSeconds, 10);
    const framesPerSecond = numericSetting(settings.buildFramesPerSecond, 2);
    const baseFrames = Math.max(2, Math.round(intervalSeconds * framesPerSecond));
    const maxGrowth = Math.max(1, numericSetting(settings.maxBuildGrowth, 3));
    const elapsedIntervals = Math.max(1, elapsedSeconds / intervalSeconds);
    const growth = Math.min(maxGrowth, 1 + Math.log2(elapsedIntervals));
    return Math.max(2, Math.round(baseFrames * growth));
  }

  function sampleRecentFrames(frameBudget: number) {
    const sourceFrames = framesRef.current;
    if (sourceFrames.length <= frameBudget) {
      return [...sourceFrames];
    }

    const sampledFrames: RecordingFrame[] = [];
    const maxIndex = sourceFrames.length - 1;
    for (let index = 0; index < frameBudget; index += 1) {
      const sourceIndex = Math.round((index * maxIndex) / (frameBudget - 1));
      sampledFrames.push(sourceFrames[sourceIndex]);
    }
    return sampledFrames;
  }

  function maybeLiveReconstruct() {
    const settings = liveSettingsRef.current;
    if (!settings.liveBuild || liveBusyRef.current || framesRef.current.length < 2) {
      return;
    }
    const intervalMs = numericSetting(settings.buildIntervalSeconds, 10) * 1000;
    const now = Date.now();
    if (now < nextLiveBuildAtRef.current) {
      return;
    }

    const elapsedSeconds = Math.max(1, (now - recordingStartedAtRef.current) / 1000);
    const frameBudget = liveBuildFrameBudget(elapsedSeconds);
    const snapshot = sampleRecentFrames(frameBudget);
    nextLiveBuildAtRef.current = now + intervalMs;
    liveBusyRef.current = true;
    setLiveBusy(true);
    setStatus(`Rebuilding ${snapshot.length} of ${framesRef.current.length} frames`);
    reconstructFrames(snapshot)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Live reconstruction failed");
        setStatus("Live reconstruction failed");
      })
      .finally(() => {
        liveBusyRef.current = false;
        setLiveBusy(false);
        if (recordingRef.current) {
          setStatus("Recording frames");
        }
      });
  }

  async function startRecording() {
    try {
      setError(null);
      setScene(null);
      setStatus(cameraSource === "drone" ? "Connecting to drone" : "Requesting camera");
      if (cameraSource === "laptop") {
        await ensureCamera();
      } else {
        stopLaptopCamera();
      }
      resetFrames();
      setRecording(true);
      recordingRef.current = true;
      recordingStartedAtRef.current = Date.now();
      nextLiveBuildAtRef.current =
        recordingStartedAtRef.current +
        numericSetting(liveSettingsRef.current.buildIntervalSeconds, 10) * 1000;
      setStatus("Recording frames");

      timerRef.current = window.setInterval(async () => {
        if (capturingRef.current) {
          return;
        }
        capturingRef.current = true;
        try {
          if (cameraSource === "drone") {
            appendFrame(await captureDroneFrame());
          } else {
            const video = videoRef.current;
            if (!video || video.readyState < 2) {
              return;
            }
            const blob = await captureFrame(video);
            appendFrame({ blob, url: URL.createObjectURL(blob) });
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to capture frame");
          setStatus("Frame capture failed");
        } finally {
          capturingRef.current = false;
        }
      }, CAPTURE_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to access camera");
      setStatus("Camera unavailable");
    }
  }

  function stopRecording() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRecording(false);
    recordingRef.current = false;
    setStatus(`Captured ${framesRef.current.length} frames`);
  }

  async function reconstructFrames(inputFrames: RecordingFrame[]) {
    const data = new FormData();
    for (const [index, frame] of inputFrames.entries()) {
      data.append("frames", frame.blob, `${String(index).padStart(6, "0")}.png`);
    }

    const response = await fetch("/api/reconstruct", {
      method: "POST",
      body: data,
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const result = (await response.json()) as SceneResult;
    setScene(result);
    setStatus(`Reconstruction ready with ${result.pointCount.toLocaleString()} points`);
  }

  async function reconstruct() {
    if (framesRef.current.length < 2) {
      setError("Record at least two frames before reconstructing.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("Running reconstruction");

    try {
      await reconstructFrames([...framesRef.current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconstruction failed");
      setStatus("Reconstruction failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="control-panel">
        <div className="eyebrow">MASt3R-SLAM recorder</div>
        <h1 className="headline">Record a room, inspect the point cloud.</h1>
        <p className="lede">
          Capture a short handheld sweep in the browser, run the reconstruction
          pipeline, then orbit the resulting 3D scene here.
        </p>

        <div className="stack">
          <div className="panel stack">
            <div className="video-frame">
              {cameraSource === "drone" ? (
                dronePreviewUrl ? (
                  <img src={dronePreviewUrl} alt="Drone camera preview" />
                ) : (
                  <div className="video-placeholder">drone camera waiting</div>
                )
              ) : (
                <video ref={videoRef} muted playsInline />
              )}
            </div>
            <div className="status-strip">
              <span>
                <span className={`dot ${recording ? "live" : ""}`} />
                {status}
              </span>
              <span>{liveBusy ? "building" : `${frames.length} frames`}</span>
            </div>
            <div className="actions">
              <button
                className="primary"
                onClick={recording ? stopRecording : startRecording}
                disabled={busy}
              >
                {recording ? "Stop recording" : "Start recording"}
              </button>
              <button
                className="accent"
                onClick={reconstruct}
                disabled={busy || liveBusy || frames.length < 2}
              >
                {busy ? "Reconstructing" : "Build scene"}
              </button>
            </div>
            <div className="source-row">
              <div className="segmented" aria-label="Camera source">
                <button
                  className={cameraSource === "laptop" ? "selected" : ""}
                  disabled={recording}
                  onClick={() => {
                    setCameraSource("laptop");
                    setFlipAxis("y");
                    setStatus("Camera idle");
                  }}
                >
                  Laptop camera
                </button>
                <button
                  className={cameraSource === "drone" ? "selected" : ""}
                  disabled={recording}
                  onClick={() => {
                    setCameraSource("drone");
                    setFlipAxis("none");
                    stopLaptopCamera();
                    setStatus("Drone camera idle");
                  }}
                >
                  Drone camera
                </button>
              </div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={liveBuild}
                  onChange={(event) => setLiveBuild(event.target.checked)}
                />
                Live build
              </label>
              <div className="control-label">Flip axis</div>
              <div className="segmented compact" aria-label="Point cloud flip axis">
                {(["none", "x", "y", "z"] as FlipAxis[]).map((axis) => (
                  <button
                    key={axis}
                    className={flipAxis === axis ? "selected" : ""}
                    onClick={() => setFlipAxis(axis)}
                  >
                    {axis}
                  </button>
                ))}
              </div>
              <label className="number-row">
                <span>Recent frames</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  value={recentFrameLimit}
                  onChange={(event) => setRecentFrameLimit(event.target.value)}
                  placeholder="0"
                />
              </label>
              <div className="settings-grid">
                <label>
                  <span>Build seconds</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={buildIntervalSeconds}
                    onChange={(event) => setBuildIntervalSeconds(event.target.value)}
                  />
                </label>
                <label>
                  <span>Frames/sec</span>
                  <input
                    type="number"
                    min="0.25"
                    step="0.25"
                    inputMode="decimal"
                    value={buildFramesPerSecond}
                    onChange={(event) => setBuildFramesPerSecond(event.target.value)}
                  />
                </label>
                <label>
                  <span>Growth cap</span>
                  <input
                    type="number"
                    min="1"
                    step="0.25"
                    inputMode="decimal"
                    value={maxBuildGrowth}
                    onChange={(event) => setMaxBuildGrowth(event.target.value)}
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="panel stack">
            <div className="status-strip">
              <strong>Captured sweep</strong>
              <span>{Math.round((frames.length * CAPTURE_INTERVAL_MS) / 100) / 10}s</span>
            </div>
            <div className="preview-grid">
              {frames.map((frame, index) => (
                <img key={frame.url} src={frame.url} alt={`Frame ${index + 1}`} />
              ))}
            </div>
          </div>

          <div className="panel stack">
            <strong>Notes</strong>
            <div className="lede" style={{ margin: 0 }}>
              Move slowly, keep overlap high, and arc around objects instead of panning in place.
            </div>
            {error ? <div style={{ color: "#8b1e00" }}>{error}</div> : null}
          </div>
        </div>
      </section>

      <section className="viewer-panel">
        <SceneViewer scene={scene} flipAxis={flipAxis} />
      </section>
    </main>
  );
}
