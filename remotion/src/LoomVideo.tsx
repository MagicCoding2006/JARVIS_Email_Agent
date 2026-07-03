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

import { loadFont } from "@remotion/google-fonts/Inter";

// Real Inter (headless Chrome has no system Inter — without this the whole
// video silently renders in a generic fallback font).
const inter = loadFont("normal", { weights: ["500", "600", "700", "800", "900"], subsets: ["latin"] });
const FONT = `${inter.fontFamily}, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;

export interface Scene {
  durationSec: number;
  headline: string;
  subtext?: string;
  /** Tiny label above the headline, e.g. "THE PROBLEM" / "THE FIX". */
  kicker?: string;
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
    /** Booking link — when set, the last scene renders a CTA button. */
    ctaUrl?: string;
    ctaLabel?: string;
    captions?: CaptionCue[];
    scenes: Scene[];
  };
}

const INK = "#f2f6fd";
const INK_MUTED = "#9fb0c8";
/** Darkest area of the stage — what accent text sits on. */
const STAGE_BG = "#0a1220";

export const LoomVideo: React.FC<LoomProps> = ({ spec, audioFile, fps }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const accent = readableAccent(spec.accent);
  let acc = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#060b14", fontFamily: FONT }}>
      {audioFile ? (
        <Audio
          src={staticFile(audioFile)}
          volume={(f) =>
            interpolate(f, [0, 8, durationInFrames - 18, durationInFrames - 3], [0, 1, 1, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          }
        />
      ) : null}
      <AmbientStage accent={accent} />
      {spec.scenes.map((scene, i) => {
        const from = acc;
        const df = Math.max(1, Math.round(scene.durationSec * fps));
        acc += df;
        return (
          <Sequence key={i} from={from} durationInFrames={df}>
            <SceneView
              scene={scene}
              accent={accent}
              spec={spec}
              index={i}
              sceneFrames={df}
              isLast={i === spec.scenes.length - 1}
            />
          </Sequence>
        );
      })}
      <TopBar spec={spec} accent={accent} />
      <VoiceOrb accent={accent} />
      <CaptionOverlay captions={spec.captions ?? []} accent={accent} />
      {/* Loom-style progress bar along the bottom edge. */}
      <div style={{ position: "absolute", left: 0, bottom: 0, height: 4, width: "100%", background: "rgba(255,255,255,0.08)" }}>
        <div style={{ height: "100%", width: `${(frame / Math.max(1, durationInFrames)) * 100}%`, background: accent, boxShadow: `0 0 12px ${hexToRgba(accent, 0.8)}` }} />
      </div>
    </AbsoluteFill>
  );
};

/** Slow-drifting accent glows — the stage never sits perfectly still. */
const AmbientStage: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const x1 = 16 + Math.sin(t * 0.21) * 7;
  const y1 = 12 + Math.cos(t * 0.17) * 6;
  const x2 = 86 + Math.cos(t * 0.13) * 6;
  const y2 = 82 + Math.sin(t * 0.19) * 7;
  return (
    <AbsoluteFill
      style={{
        background:
          `radial-gradient(720px circle at ${x1}% ${y1}%, ${hexToRgba(accent, 0.17)}, transparent 62%),` +
          `radial-gradient(640px circle at ${x2}% ${y2}%, rgba(56,102,255,0.10), transparent 60%),` +
          `linear-gradient(148deg, #0a1322 0%, #0a1120 46%, #05080f 100%)`,
      }}
    >
      {/* faint grid for depth — recessive, never competes with content */}
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage: "radial-gradient(ellipse at 40% 40%, black 30%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse at 40% 40%, black 30%, transparent 78%)",
        }}
      />
    </AbsoluteFill>
  );
};

const TopBar: React.FC<{ spec: LoomProps["spec"]; accent: string }> = ({ spec, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 4, fps, config: { damping: 200 } });
  const y = interpolate(enter, [0, 1], [-28, 0]);
  return (
    <div style={{ position: "absolute", top: 26, left: 40, right: 40, display: "flex", justifyContent: "space-between", alignItems: "center", transform: `translateY(${y}px)`, opacity: enter }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(8,14,26,0.72)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 999, padding: "7px 18px 7px 9px" }}>
        {spec.logoUrl ? (
          <Img src={assetSrc(spec.logoUrl)} style={{ width: 32, height: 32, borderRadius: 8, objectFit: "contain", background: "rgba(255,255,255,0.94)", padding: 3 }} />
        ) : (
          <span style={{ width: 11, height: 11, marginLeft: 6, borderRadius: 99, background: accent, boxShadow: `0 0 14px ${accent}` }} />
        )}
        <span style={{ fontSize: 19, fontWeight: 800, color: INK, letterSpacing: -0.2 }}>{spec.companyName ?? "Quick video"}</span>
      </div>
      {spec.prospectName ? (
        <div style={{ display: "flex", alignItems: "center", gap: 9, background: "rgba(8,14,26,0.72)", border: `1px solid ${hexToRgba(accent, 0.45)}`, borderRadius: 999, padding: "8px 16px", fontSize: 16, fontWeight: 600, color: INK }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: accent, boxShadow: `0 0 10px ${accent}` }} />
          Made for {spec.prospectName}
        </div>
      ) : null}
    </div>
  );
};

const SceneView: React.FC<{
  scene: Scene;
  accent: string;
  spec: LoomProps["spec"];
  index: number;
  sceneFrames: number;
  isLast: boolean;
}> = ({ scene, accent, spec, index, sceneFrames, isLast }) => {
  const frame = useCurrentFrame();
  // Exit: lift + fade over the scene's last 12 frames (except the very last scene).
  const exit = isLast ? 1 : interpolate(frame, [sceneFrames - 12, sceneFrames - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const hasWebsite = Boolean(index <= 1 && scene.bgImageUrl);

  return (
    <AbsoluteFill style={{ opacity: exit, transform: `translateY(${(1 - exit) * -18}px)` }}>
      <div style={{ position: "absolute", top: 96, bottom: 118, left: 64, right: 64, display: "flex", alignItems: "center", gap: 44 }}>
        {/* Copy column */}
        <div style={{ flex: hasWebsite ? "0 0 46%" : "1 1 auto", maxWidth: hasWebsite ? undefined : 900, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {scene.kicker ? <Kicker text={scene.kicker} accent={accent} /> : null}
          <StaggeredHeadline text={scene.headline} accent={accent} highlight={scene.highlight} compact={hasWebsite} />
          {scene.subtext ? <Subtext text={scene.subtext} compact={hasWebsite} /> : null}
          {/* The closing scene gets ONE focal point: the booking button. Stat
              tiles yield to it so the ask never competes with a number. */}
          {scene.dataPoints?.length && !(isLast && spec.ctaUrl) ? <DataPoints points={scene.dataPoints} accent={accent} /> : null}
          {isLast && spec.ctaUrl ? <CtaButton url={spec.ctaUrl} label={spec.ctaLabel} accent={accent} /> : null}
        </div>
        {/* Website column */}
        {hasWebsite ? (
          <div style={{ flex: "1 1 54%", height: "100%" }}>
            <WebsiteCard src={scene.bgImageUrl!} accent={accent} websiteUrl={spec.websiteUrl} sceneFrames={sceneFrames} />
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

const Kicker: React.FC<{ text: string; accent: string }> = ({ text, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  return (
    <div style={{ display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 9, marginBottom: 18, padding: "7px 14px", borderRadius: 999, background: hexToRgba(accent, 0.13), border: `1px solid ${hexToRgba(accent, 0.42)}`, opacity: enter, transform: `translateY(${(1 - enter) * 14}px)` }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: accent }} />
      <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: 2.2, color: ensureContrast(accent, STAGE_BG, 6), textTransform: "uppercase" }}>{text}</span>
    </div>
  );
};

/** Headline with per-word staggered rise and accent-painted highlight. */
const StaggeredHeadline: React.FC<{ text: string; accent: string; highlight?: string; compact: boolean }> = ({ text, accent, highlight, compact }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const size = fitHeadline(text, compact);
  const hl = (highlight ?? "").trim().toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  // Which word indices belong to the highlight phrase (match as a word run).
  const highlightSet = new Set<number>();
  if (hl) {
    const hlWords = hl.split(/\s+/);
    const norm = (w: string) => w.toLowerCase().replace(/^[^\w$]+|[^\w%$]+$/g, "");
    for (let i = 0; i + hlWords.length <= words.length; i++) {
      if (hlWords.every((w, j) => norm(words[i + j]) === norm(w) || norm(words[i + j]).includes(norm(w)))) {
        for (let j = 0; j < hlWords.length; j++) highlightSet.add(i + j);
        break;
      }
    }
  }

  return (
    <div style={{ fontSize: size, lineHeight: 1.06, fontWeight: 900, letterSpacing: -1.2, color: INK, textShadow: "0 6px 30px rgba(0,0,0,0.5)" }}>
      {words.map((word, i) => {
        const enter = spring({ frame: frame - 3 - i * 2.2, fps, config: { damping: 16, mass: 0.7 } });
        const isHl = highlightSet.has(i);
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              whiteSpace: "pre",
              opacity: Math.min(1, enter * 1.4),
              transform: `translateY(${(1 - enter) * 26}px)`,
              color: isHl ? accent : INK,
              textShadow: isHl ? `0 0 26px ${hexToRgba(accent, 0.5)}` : undefined,
            }}
          >
            {word}
            {i < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </div>
  );
};

const Subtext: React.FC<{ text: string; compact: boolean }> = ({ text, compact }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 12, fps, config: { damping: 200 } });
  return (
    <div style={{ marginTop: 16, fontSize: fitSubtext(text, compact), lineHeight: 1.3, fontWeight: 500, color: INK_MUTED, maxWidth: 620, opacity: enter, transform: `translateY(${(1 - enter) * 12}px)` }}>
      {text}
    </div>
  );
};

/** Stat tiles: hero value counts up in accent; label stays in muted ink. */
const DataPoints: React.FC<{ points: { label: string; value: string }[]; accent: string }> = ({ points, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", gap: 18, marginTop: 30 }}>
      {points.slice(0, 3).map((d, i) => {
        const enter = spring({ frame: frame - 16 - i * 4, fps, config: { damping: 15, mass: 0.8 } });
        return (
          <div key={i} style={{ minWidth: 190, maxWidth: 250, background: "rgba(255,255,255,0.055)", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 14, padding: "16px 20px 14px", boxShadow: "0 16px 40px rgba(0,0,0,0.3)", opacity: enter, transform: `translateY(${(1 - enter) * 22}px) scale(${0.94 + enter * 0.06})` }}>
            <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: -0.6, color: accent }}>
              <CountUpValue value={d.value} startFrame={16 + i * 4} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK_MUTED, marginTop: 3 }}>{d.label}</div>
            <div style={{ height: 3, width: 44, background: accent, borderRadius: 2, marginTop: 10, opacity: 0.9 }} />
          </div>
        );
      })}
    </div>
  );
};

/** Animates the numeric part of "$30,000" / "< 30 seconds" counting up. */
const CountUpValue: React.FC<{ value: string; startFrame: number }> = ({ value, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const m = value.match(/([\d][\d,]*(?:\.\d+)?)/);
  if (!m || m.index === undefined) return <>{value}</>;
  const target = Number.parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(target)) return <>{value}</>;
  const progress = spring({ frame: frame - startFrame, fps, config: { damping: 22, mass: 0.9 }, durationInFrames: 34 });
  const current = target * progress;
  const decimals = m[1].includes(".") ? (m[1].split(".")[1] ?? "").length : 0;
  const grouped = m[1].includes(",");
  const shown = current.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouped,
  });
  return (
    <>
      {value.slice(0, m.index)}
      {shown}
      {value.slice(m.index + m[1].length)}
    </>
  );
};

/** The prospect's site in a floating browser card that slowly scrolls. */
const WebsiteCard: React.FC<{ src: string; accent: string; websiteUrl?: string; sceneFrames: number }> = ({ src, accent, websiteUrl, sceneFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 5, fps, config: { damping: 18, mass: 0.9 } });
  const float = Math.sin((frame / fps) * 1.15) * 5;
  // Slow scroll down the page over the scene (the "I looked at your site" move).
  const scroll = interpolate(frame, [10, Math.max(11, sceneFrames - 6)], [0, 58], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        opacity: enter,
        transform: `perspective(1400px) rotateY(-3.5deg) translateX(${(1 - enter) * 90}px) translateY(${float}px)`,
        borderRadius: 18,
        overflow: "hidden",
        border: `1px solid ${hexToRgba(accent, 0.4)}`,
        boxShadow: `0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05), 0 0 60px ${hexToRgba(accent, 0.14)}`,
        background: "#0e1626",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ height: 40, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", background: "rgba(13,20,35,0.97)", borderBottom: "1px solid rgba(255,255,255,0.09)" }}>
        <span style={{ width: 11, height: 11, borderRadius: 99, background: "#ff5f57" }} />
        <span style={{ width: 11, height: 11, borderRadius: 99, background: "#ffbd2e" }} />
        <span style={{ width: 11, height: 11, borderRadius: 99, background: "#28c840" }} />
        {websiteUrl ? (
          <span style={{ marginLeft: 12, display: "flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,0.07)", borderRadius: 8, padding: "4px 12px", color: "#c3cede", fontSize: 14, fontWeight: 500 }}>
            <span style={{ color: "#7ee2a8", fontSize: 12 }}>🔒</span>
            {websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </span>
        ) : null}
      </div>
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <Img src={assetSrc(src)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: `50% ${scroll}%` }} />
        {/* gentle bottom fade keeps the card grounded on the stage */}
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 62%, rgba(6,11,20,0.42))" }} />
      </div>
    </div>
  );
};

/** Booking CTA on the closing scene — reads as a button, pulses for attention. */
const CtaButton: React.FC<{ url: string; label?: string; accent: string }> = ({ url, label, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 22, fps, config: { damping: 14, mass: 0.8 } });
  const pulse = 1 + Math.sin((frame / fps) * 2.6) * 0.012;
  const domain = url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const onAccent = idealTextColor(accent);
  return (
    <div style={{ marginTop: 34, display: "flex", alignItems: "center", gap: 18, opacity: enter, transform: `translateY(${(1 - enter) * 24}px)` }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 12, background: accent, color: onAccent, borderRadius: 999, padding: "16px 30px", fontSize: 23, fontWeight: 800, letterSpacing: -0.3, boxShadow: `0 14px 44px ${hexToRgba(accent, 0.45)}, 0 0 0 ${Math.max(0, Math.sin((frame / fps) * 2.6)) * 7}px ${hexToRgba(accent, 0.16)}`, transform: `scale(${pulse})` }}>
        {label ?? "Book a quick demo"}
        <span style={{ fontSize: 24, lineHeight: 1 }}>→</span>
      </div>
      <div style={{ fontSize: 17, fontWeight: 600, color: INK_MUTED }}>{domain}</div>
    </div>
  );
};

/** Loom-style presence: a pulsing voice orb with a deterministic equalizer. */
const VoiceOrb: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 8, fps, config: { damping: 200 } });
  const t = frame / fps;
  const bars = [0, 1, 2, 3, 4].map((i) => {
    const h = 8 + Math.abs(Math.sin(t * (3.1 + i * 0.83) + i * 1.7)) * 15;
    return h;
  });
  const ring = 1 + Math.sin(t * 2.2) * 0.05;
  return (
    <div style={{ position: "absolute", left: 40, bottom: 30, display: "flex", alignItems: "center", gap: 13, opacity: enter, transform: `translateY(${(1 - enter) * 20}px)` }}>
      <div style={{ width: 58, height: 58, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", gap: 3, background: `radial-gradient(circle at 32% 28%, ${hexToRgba(accent, 0.5)}, rgba(10,16,28,0.92) 70%)`, border: `1.5px solid ${hexToRgba(accent, 0.55)}`, boxShadow: `0 0 ${18 * ring}px ${hexToRgba(accent, 0.35)}`, transform: `scale(${ring})` }}>
        {bars.map((h, i) => (
          <span key={i} style={{ width: 3.5, height: h, borderRadius: 3, background: INK, opacity: 0.92 }} />
        ))}
      </div>
      <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1.6, color: INK_MUTED, textTransform: "uppercase" }}>Audio on</span>
    </div>
  );
};

/** Karaoke captions: the words already spoken tint toward the accent. */
const CaptionOverlay: React.FC<{ captions: CaptionCue[]; accent: string }> = ({ captions, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = frame / fps;
  const idx = captions.findIndex((c) => sec >= c.startSec && sec < c.endSec);
  if (idx === -1) return null;
  const cue = captions[idx];
  const cueStartFrame = Math.round(cue.startSec * fps);
  const pop = spring({ frame: frame - cueStartFrame, fps, config: { damping: 16, mass: 0.6 }, durationInFrames: 10 });

  const words = cue.text.split(/\s+/).filter(Boolean);
  const totalChars = words.reduce((sum, w) => sum + w.length, 0) || 1;
  const cueDur = cue.endSec - cue.startSec;
  const spokenAccent = ensureContrast(accent, "#0a101d", 5);
  let charAcc = 0;

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 26, pointerEvents: "none" }}>
      <div style={{ maxWidth: 880, textAlign: "center", background: "rgba(7,12,22,0.86)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 13, padding: "12px 24px", fontSize: fitCaption(cue.text), lineHeight: 1.25, fontWeight: 700, boxShadow: "0 16px 44px rgba(0,0,0,0.45)", opacity: pop, transform: `translateY(${(1 - pop) * 12}px) scale(${0.97 + pop * 0.03})` }}>
        {words.map((word, i) => {
          const wordStart = cue.startSec + (charAcc / totalChars) * cueDur;
          charAcc += word.length;
          const spoken = sec >= wordStart;
          return (
            <span key={i} style={{ color: spoken ? spokenAccent : INK, opacity: spoken ? 1 : 0.55, transition: "none" }}>
              {word}
              {i < words.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ── sizing ────────────────────────────────────────────────────────────────────

function fitHeadline(text: string, compact: boolean): number {
  const base = compact ? 52 : 66;
  if (text.length > 86) return compact ? 34 : 42;
  if (text.length > 64) return compact ? 40 : 50;
  if (text.length > 44) return compact ? 46 : 58;
  return base;
}

function fitSubtext(text: string, compact: boolean): number {
  if (text.length > 150) return compact ? 18 : 20;
  if (text.length > 110) return compact ? 20 : 22;
  return compact ? 22 : 24;
}

function fitCaption(text: string): number {
  if (text.length > 78) return 22;
  if (text.length > 60) return 24;
  return 26;
}

// ── assets & color ────────────────────────────────────────────────────────────

function assetSrc(src: string): string {
  return /^https?:\/\//i.test(src) || /^data:/i.test(src) ? src : staticFile(src);
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
 * Keep the brand's hue but force a vivid saturation, then push the lightness
 * until the color has real WCAG contrast against our dark stage. HSL "lightness"
 * alone isn't enough: a blue at 65% lightness still has low luminance and blends
 * into the dark background, so we drive by measured contrast instead.
 */
function readableAccent(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  // A near-gray/white brand color has no usable hue — forcing saturation would
  // invent an arbitrary tint. Fall back to our default green accent instead.
  if (s < 0.12) return ensureContrast("#22c55e", STAGE_BG, 5.5);
  const vivid = hslToHex(h, Math.max(s, 0.55), Math.max(l, 0.5));
  return ensureContrast(vivid, STAGE_BG, 5.5);
}

/**
 * Pick "ink or paper" — the most readable of near-white / near-black — for text
 * placed directly on `bg`. Dark backgrounds get light text, light backgrounds
 * get dark text.
 */
function idealTextColor(bg: string): string {
  return relLuminance(hexToRgb(bg)) < 0.45 ? "#f6f9ff" : "#0b1118";
}

/**
 * Shift a color's lightness until it meets `target` WCAG contrast against `bg`,
 * lightening on dark backgrounds and darkening on light ones. Hue/saturation
 * are preserved so the brand color stays recognizable.
 */
function ensureContrast(color: string, bg: string, target: number): string {
  const lighten = relLuminance(hexToRgb(bg)) < 0.4;
  const { h, s, l } = rgbToHsl(...rgbTuple(color));
  let light = l;
  let out = color;
  for (let i = 0; i < 26; i++) {
    out = hslToHex(h, s, light);
    if (contrastRatio(hexToRgb(out), hexToRgb(bg)) >= target) break;
    light = lighten ? light + 0.035 : light - 0.035;
    if (light >= 0.98 || light <= 0.02) {
      out = hslToHex(h, s, Math.max(0.02, Math.min(0.98, light)));
      break;
    }
  }
  return out;
}

function rgbTuple(hex: string): [number, number, number] {
  const { r, g, b } = hexToRgb(hex);
  return [r, g, b];
}

/** WCAG relative luminance (0 = black, 1 = white). */
function relLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const la = relLuminance(a) + 0.05;
  const lb = relLuminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
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
