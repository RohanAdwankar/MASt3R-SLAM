"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";

type SceneResult = {
  sceneId: string;
  plyUrl: string;
  pointCount: number;
};

export function SceneViewer({ scene }: { scene: SceneResult | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [webglError, setWebglError] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!gl) {
      setWebglError(true);
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      setWebglError(false);
    } catch {
      setWebglError(true);
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.innerHTML = "";
    host.appendChild(renderer.domElement);

    const scene3d = new THREE.Scene();
    scene3d.background = new THREE.Color(0x080808);

    const camera = new THREE.PerspectiveCamera(
      50,
      host.clientWidth / host.clientHeight,
      0.01,
      100,
    );
    camera.position.set(0.6, 0.6, 2.4);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene3d.add(new THREE.AmbientLight(0xffffff, 0.9));
    const light = new THREE.DirectionalLight(0xfff1d6, 1.4);
    light.position.set(2, 4, 3);
    scene3d.add(light);

    const grid = new THREE.GridHelper(6, 12, 0x8d8d8d, 0x303030);
    grid.position.y = -0.8;
    scene3d.add(grid);

    let points: THREE.Points | null = null;

    if (scene) {
      const loader = new PLYLoader();
      loader.load(scene.plyUrl, (geometry) => {
        geometry.computeBoundingSphere();
        geometry.center();

        const material = new THREE.PointsMaterial({
          size: 0.012,
          vertexColors: true,
          sizeAttenuation: true,
        });

        points = new THREE.Points(geometry, material);
        scene3d.add(points);

        const radius = geometry.boundingSphere?.radius ?? 1;
        camera.position.set(radius * 0.8, radius * 0.55, radius * 2.1);
        controls.target.set(0, 0, 0);
        controls.update();
      });
    }

    const resizeObserver = new ResizeObserver(() => {
      if (!hostRef.current) {
        return;
      }
      camera.aspect = hostRef.current.clientWidth / hostRef.current.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(hostRef.current.clientWidth, hostRef.current.clientHeight);
    });
    resizeObserver.observe(host);

    let mounted = true;
    const renderLoop = () => {
      if (!mounted) {
        return;
      }
      controls.update();
      renderer.render(scene3d, camera);
      requestAnimationFrame(renderLoop);
    };
    renderLoop();

    return () => {
      mounted = false;
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      if (points) {
        points.geometry.dispose();
        (points.material as THREE.Material).dispose();
      }
    };
  }, [scene]);

  return (
    <div className="viewer-frame">
      {webglError ? (
        <div className="viewer-empty">
          <div className="eyebrow">Scene output</div>
          <h2 style={{ margin: "0.35rem 0 0.8rem" }}>3D viewer unavailable.</h2>
          <p style={{ margin: 0 }}>
            This browser cannot create a WebGL context. The scene will render in a browser with WebGL enabled.
          </p>
        </div>
      ) : !scene ? (
        <div className="viewer-empty">
          <div className="eyebrow">Scene output</div>
          <h2 style={{ margin: "0.35rem 0 0.8rem" }}>No reconstruction yet.</h2>
          <p style={{ margin: 0 }}>
            Record a short sweep, stop, then build the scene. The point cloud will load here.
          </p>
        </div>
      ) : (
        <div className="viewer-meta">
          <span>{scene.sceneId}</span>
          <span>{scene.pointCount.toLocaleString()} points</span>
        </div>
      )}
      <div ref={hostRef} className="viewer-canvas" />
    </div>
  );
}
