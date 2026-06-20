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
  highlight?: string;
  dataPoints?: { label: string; value: string }[];
  bgImageUrl?: string;
}

export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface LoomProps {
  fps: number;
  durationInFrames: number;
  audioFile: string;
  spec: {
    title: string;
    accent: string;
    prospectName?: string;
    companyName?: string;
    websiteUrl?: string;
    logoUrl?: string;
    captions?: CaptionCue[];
    scenes: Scene[];
  };
}

export const LoomVideo: React.FC<LoomProps> = ({ spec, audioFile, fps }) => {
  // The brand accent is scraped from the prospect's site and can be any color —
  // including ones too dark/washed-out to read on our dark stage. Clamp it to a
  // legible luminance band so accent-colored text and chrome stay readable.
  const accent = readableAccent(spec.accent);
  let acc = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#071014", fontFamily: "Inter, Arial, sans-serif" }}>
      {audioFile ? <Audio src={staticFile(audioFile)} /> : null}
      <AbsoluteFill style={{ background: `radial-gradient(circle at 20% 10%, ${hexToRgba(accent, 0.28)}, transparent 34%), linear-gradient(135deg, #071014 0%, #101623 52%, #05070b 100%)` }} />
      {spec.scenes.map((scene, i) => {
        const from = acc;
        const durationInFrames = Math.max(1, Math.round(scene.durationSec * fps));
        acc += durationInFrames;
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames}>
            <SceneView scene={scene} accent={accent} spec={spec} index={i} />
          </Sequence>
        );
      })}
      <CaptionOverlay captions={spec.captions ?? []} accent={accent} />
    </AbsoluteFill>
  );
};

const SceneView: React.FC<{ scene: Scene; accent: string; spec: LoomProps["spec"]; index: number }> = ({ scene, accent, spec, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const y = interpolate(enter, [0, 1], [40, 0]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const scale = interpolate(enter, [0, 1], [0.96, 1]);
  const hasWebsite = Boolean(index <= 1 && scene.bgImageUrl);

  return (
    <AbsoluteFill style={{ padding: 62 }}>
      {scene.bgImageUrl ? <WebsiteBackdrop src={scene.bgImageUrl} accent={accent} websiteUrl={spec.websiteUrl} /> : null}
      <div style={{ position: "absolute", top: 48, left: 58, right: 58, display: "flex", justifyContent: "space-between", alignItems: "center", color: "white" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {spec.logoUrl ? (
            <Img
              src={assetSrc(spec.logoUrl)}
              style={{ width: 38, height: 38, borderRadius: 9, objectFit: "contain", background: "rgba(255,255,255,0.92)", padding: 4, boxShadow: `0 0 22px ${hexToRgba(accent, 0.5)}` }}
            />
          ) : (
            <div style={{ width: 13, height: 13, borderRadius: 99, background: accent, boxShadow: `0 0 22px ${accent}` }} />
          )}
          <div style={{ fontSize: 22, fontWeight: 800 }}>{spec.companyName ?? "Quick video"}</div>
        </div>
        {spec.prospectName ? (
          <div style={{ border: `1px solid ${hexToRgba(accent, 0.62)}`, background: "rgba(0,0,0,0.38)", borderRadius: 999, padding: "10px 18px", fontSize: 18, color: "#e9eef6" }}>
            For {spec.prospectName}
          </div>
        ) : null}
      </div>

      <div style={{
        transform: `translateY(${y}px) scale(${scale})`,
        transformOrigin: "left top",
        opacity,
        color: "white",
        position: "absolute",
        left: 78,
        right: hasWebsite ? 180 : 78,
        top: hasWebsite ? 248 : 138,
        bottom: 136,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        justifyContent: hasWebsite ? "flex-end" : "center",
      }}>
        {!hasWebsite ? (
          <div style={{ display: "inline-flex", alignItems: "center", alignSelf: "flex-start", gap: 10, background: hexToRgba(accent, 0.16), border: `1px solid ${hexToRgba(accent, 0.5)}`, borderRadius: 999, padding: "8px 14px", color: "#eaf7ff", fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: accent }} />
            Personalized idea
          </div>
        ) : null}
        {/* On a website backdrop, sit the copy on a dark panel so it always reads
            cleanly over whatever the screenshot looks like. */}
        <div style={hasWebsite ? {
          alignSelf: "flex-start",
          maxWidth: 760,
          background: "rgba(4,9,16,0.66)",
          border: `1px solid ${hexToRgba(accent, 0.3)}`,
          borderLeft: `6px solid ${accent}`,
          borderRadius: 16,
          padding: "22px 26px",
          boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        } : { alignSelf: "flex-start", maxWidth: 960 }}>
          <div style={{ fontSize: fitHeadline(scene.headline, hasWebsite), lineHeight: 1.04, fontWeight: 900, letterSpacing: 0, textShadow: "0 10px 34px rgba(0,0,0,0.65)" }}>
            <HighlightedHeadline text={scene.headline} accent={accent} highlight={scene.highlight} />
          </div>
          {scene.subtext ? <div style={{ marginTop: 14, fontSize: fitSubtext(scene.subtext, hasWebsite), lineHeight: 1.24, color: "#e2e8f2", maxHeight: hasWebsite ? 80 : 118, overflow: "hidden", textShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>{scene.subtext}</div> : null}
        </div>
        {scene.dataPoints?.length ? <DataPoints points={scene.dataPoints} accent={accent} /> : null}
      </div>
    </AbsoluteFill>
  );
};

const WebsiteBackdrop: React.FC<{ src: string; accent: string; websiteUrl?: string }> = ({ src, accent, websiteUrl }) => {
  return (
    <AbsoluteFill style={{ padding: "94px 74px 170px" }}>
      <div style={{ width: "100%", height: "100%", borderRadius: 24, overflow: "hidden", border: `2px solid ${hexToRgba(accent, 0.44)}`, boxShadow: "0 34px 90px rgba(0,0,0,0.58)", background: "#0f172a" }}>
        <div style={{ height: 42, display: "flex", alignItems: "center", gap: 9, padding: "0 16px", background: "rgba(15,23,42,0.94)", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
          <span style={{ width: 12, height: 12, borderRadius: 99, background: "#ff5f57" }} />
          <span style={{ width: 12, height: 12, borderRadius: 99, background: "#ffbd2e" }} />
          <span style={{ width: 12, height: 12, borderRadius: 99, background: "#28c840" }} />
          {websiteUrl ? <span style={{ marginLeft: 14, color: "#b7c4d7", fontSize: 16 }}>{websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span> : null}
        </div>
        <Img src={assetSrc(src)} style={{ width: "100%", height: "calc(100% - 42px)", objectFit: "cover", opacity: 0.68 }} />
      </div>
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(7,16,20,0.05), rgba(7,16,20,0.82) 78%)" }} />
    </AbsoluteFill>
  );
};

// Strategic highlights: paint only the key stat/keyword in the brand color so
// the eye lands on "30 seconds" / "no setup fee" / "$10,000", not the whole line.
const HIGHLIGHT_SOURCES = [
  "\\$[\\d,]+(?:\\.\\d+)?\\s?(?:million|k)?(?:/[a-z]+)?",
  "\\d+\\s?(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|%|x)\\b",
  "no setup fee",
  "booked jobs?",
  "locked for life",
  "30 seconds",
  "48 hours",
];

const HighlightedHeadline: React.FC<{ text: string; accent: string; highlight?: string }> = ({ text, accent, highlight }) => {
  const sources = [
    ...(highlight && highlight.trim() ? [escapeRegExp(highlight.trim())] : []),
    ...HIGHLIGHT_SOURCES,
  ];
  const splitter = new RegExp(`(${sources.join("|")})`, "gi");
  const isMatch = new RegExp(`^(?:${sources.join("|")})$`, "i");
  const parts = text.split(splitter).filter((p) => p);
  return (
    <>
      {parts.map((part, i) =>
        isMatch.test(part) ? (
          <span key={i} style={{ color: accent, textShadow: `0 0 22px ${hexToRgba(accent, 0.45)}` }}>{part}</span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
};

const DataPoints: React.FC<{ points: { label: string; value: string }[]; accent: string }> = ({ points, accent }) => (
  <div style={{ display: "flex", gap: 22, marginTop: 34 }}>
    {points.slice(0, 3).map((d, i) => (
      <div key={i} style={{ width: 230, background: "rgba(255,255,255,0.08)", borderRadius: 14, padding: "18px 22px", border: "1px solid rgba(255,255,255,0.13)", borderBottom: `5px solid ${accent}`, boxShadow: "0 18px 44px rgba(0,0,0,0.28)" }}>
        <div style={{ fontSize: 38, fontWeight: 900, color: accent }}>{d.value}</div>
        <div style={{ fontSize: 17, color: "#cbd5e1", marginTop: 4 }}>{d.label}</div>
      </div>
    ))}
  </div>
);

const CaptionOverlay: React.FC<{ captions: CaptionCue[]; accent: string }> = ({ captions, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  const cue = captions.find((c) => sec >= c.startSec && sec < c.endSec);
  if (!cue) return null;

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 32, pointerEvents: "none" }}>
      <div style={{ maxWidth: 930, textAlign: "center", background: "rgba(3,7,18,0.8)", border: `1px solid ${hexToRgba(accent, 0.38)}`, color: "#f8fafc", borderRadius: 12, padding: "12px 22px", fontSize: fitCaption(cue.text), lineHeight: 1.18, fontWeight: 800, boxShadow: "0 18px 48px rgba(0,0,0,0.4)" }}>
        {cue.text}
      </div>
    </AbsoluteFill>
  );
};

function assetSrc(src: string): string {
  return /^https?:\/\//i.test(src) || /^data:/i.test(src) ? src : staticFile(src);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fitHeadline(text: string, compact = false): number {
  const base = compact ? 54 : 64;
  if (text.length > 86) return compact ? 38 : 44;
  if (text.length > 68) return compact ? 42 : 50;
  if (text.length > 48) return compact ? 48 : 56;
  return base;
}

function fitSubtext(text: string, compact = false): number {
  if (text.length > 150) return compact ? 19 : 21;
  if (text.length > 110) return compact ? 21 : 23;
  return compact ? 23 : 25;
}

function fitCaption(text: string): number {
  if (text.length > 78) return 23;
  if (text.length > 60) return 25;
  return 27;
}

function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "22c55e";
  const n = Number.parseInt(clean, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Keep the brand's hue but force enough saturation + lightness that the color
 * reads clearly as text/UI on our near-black stage. Dark brand colors (navy,
 * charcoal) get brightened; muddy ones get a saturation floor.
 */
function readableAccent(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  // A near-gray/white brand color has no usable hue — forcing saturation would
  // invent an arbitrary tint. Fall back to our default green accent instead.
  if (s < 0.12) return "#22c55e";
  const sat = Math.max(s, 0.5);
  const light = Math.min(0.72, Math.max(0.58, l));
  return hslToHex(h, sat, light);
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
