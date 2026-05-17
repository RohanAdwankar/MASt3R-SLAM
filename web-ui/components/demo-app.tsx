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

const CAPTURE_INTERVAL_MS = 350;
const LIVE_REBUILD_FRAME_STEP = 4;
const DEFAULT_RECENT_FRAME_LIMIT = "0";

function captureFrame(video: HTMLVideoElement, flipped: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create frame context");
  }
  if (flipped) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
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
  const lastLiveBuildFrameRef = useRef(0);
  const dronePreviewUrlRef = useRef<string | null>(null);

  const [frames, setFrames] = useState<RecordingFrame[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveBuild, setLiveBuild] = useState(true);
  const [cameraSource, setCameraSource] = useState<CameraSource>("laptop");
  const [flipCamera, setFlipCamera] = useState(true);
  const [recentFrameLimit, setRecentFrameLimit] = useState(DEFAULT_RECENT_FRAME_LIMIT);
  const [dronePreviewUrl, setDronePreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("Camera idle");
  const [scene, setScene] = useState<SceneResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  function maybeLiveReconstruct() {
    if (!liveBuild || liveBusyRef.current || framesRef.current.length < 2) {
      return;
    }
    if (framesRef.current.length - lastLiveBuildFrameRef.current < LIVE_REBUILD_FRAME_STEP) {
      return;
    }

    const snapshot = [...framesRef.current];
    lastLiveBuildFrameRef.current = snapshot.length;
    liveBusyRef.current = true;
    setLiveBusy(true);
    setStatus(`Rebuilding from ${snapshot.length} frames`);
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
      lastLiveBuildFrameRef.current = 0;
      setStatus(cameraSource === "drone" ? "Connecting to drone" : "Requesting camera");
      if (cameraSource === "laptop") {
        await ensureCamera();
      } else {
        stopLaptopCamera();
      }
      resetFrames();
      setRecording(true);
      recordingRef.current = true;
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
            const blob = await captureFrame(video, flipCamera);
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
                  <img
                    className={flipCamera ? "flipped" : ""}
                    src={dronePreviewUrl}
                    alt="Drone camera preview"
                  />
                ) : (
                  <div className="video-placeholder">drone camera waiting</div>
                )
              ) : (
                <video
                  ref={videoRef}
                  className={flipCamera ? "flipped" : ""}
                  muted
                  playsInline
                />
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
                    setFlipCamera(true);
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
                    setFlipCamera(false);
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
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={flipCamera}
                  onChange={(event) => setFlipCamera(event.target.checked)}
                />
                Flip camera
              </label>
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
        <SceneViewer scene={scene} />
      </section>
    </main>
  );
}
