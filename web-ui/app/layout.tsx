import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MASt3R-SLAM Recorder",
  description: "Record a scene, reconstruct it, and inspect the point cloud.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
