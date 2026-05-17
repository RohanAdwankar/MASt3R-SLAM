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

const CAPTURE_INTERVAL_MS = 350;

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

  const [frames, setFrames] = useState<RecordingFrame[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
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

  function resetFrames() {
    for (const frame of framesRef.current) {
      URL.revokeObjectURL(frame.url);
    }
    framesRef.current = [];
    setFrames([]);
  }

  async function startRecording() {
    try {
      setError(null);
      setScene(null);
      setStatus("Requesting camera");
      await ensureCamera();
      resetFrames();
      setRecording(true);
      setStatus("Recording frames");

      timerRef.current = window.setInterval(async () => {
        const video = videoRef.current;
        if (!video || video.readyState < 2) {
          return;
        }
        const blob = await captureFrame(video);
        const frame = { blob, url: URL.createObjectURL(blob) };
        framesRef.current = [...framesRef.current, frame].slice(-16);
        setFrames(framesRef.current);
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
    setStatus(`Captured ${framesRef.current.length} frames`);
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
      const data = new FormData();
      for (const [index, frame] of framesRef.current.entries()) {
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
              <video ref={videoRef} muted playsInline />
            </div>
            <div className="status-strip">
              <span>
                <span className={`dot ${recording ? "live" : ""}`} />
                {status}
              </span>
              <span>{frames.length} frames</span>
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
                disabled={recording || busy || frames.length < 2}
              >
                {busy ? "Reconstructing" : "Build scene"}
              </button>
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
