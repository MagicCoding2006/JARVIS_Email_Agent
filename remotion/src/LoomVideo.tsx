import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export interface Scene {
  durationSec: number;
  headline: string;
  subtext?: string;
  dataPoints?: { label: string; value: string }[];
  bgImageUrl?: string;
}

export interface LoomProps {
  fps: number;
  durationInFrames: number;
  audioFile: string;
  spec: { title: string; accent: string; scenes: Scene[] };
}

export const LoomVideo: React.FC<LoomProps> = ({ spec, audioFile, fps }) => {
  let acc = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0b14" }}>
      {audioFile ? <Audio src={staticFile(audioFile)} /> : null}
      {spec.scenes.map((scene, i) => {
        const from = acc;
        const durationInFrames = Math.max(1, Math.round(scene.durationSec * fps));
        acc += durationInFrames;
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames}>
            <SceneView scene={scene} accent={spec.accent} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const SceneView: React.FC<{ scene: Scene; accent: string }> = ({ scene, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const y = interpolate(enter, [0, 1], [40, 0]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 80 }}>
      {scene.bgImageUrl ? (
        <AbsoluteFill style={{ opacity: 0.18 }}>
          <Img src={scene.bgImageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
      ) : null}
      <div style={{ transform: `translateY(${y}px)`, opacity, textAlign: "center", color: "white", fontFamily: "Inter, Arial, sans-serif" }}>
        <div style={{ fontSize: 64, fontWeight: 800, marginBottom: 16 }}>{scene.headline}</div>
        {scene.subtext ? <div style={{ fontSize: 30, color: "#c7c7d1" }}>{scene.subtext}</div> : null}
        {scene.dataPoints?.length ? (
          <div style={{ display: "flex", gap: 32, justifyContent: "center", marginTop: 40 }}>
            {scene.dataPoints.map((d, i) => (
              <div key={i} style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: "20px 28px", borderBottom: `4px solid ${accent}` }}>
                <div style={{ fontSize: 44, fontWeight: 800, color: accent }}>{d.value}</div>
                <div style={{ fontSize: 20, color: "#a9a9b8" }}>{d.label}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
