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

const inter = loadFont("normal", { weights: ["500", "600", "700", "800", "900"], subsets: ["latin"] });
const FONT = `${inter.fontFamily}, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;

export type SceneVisual = "website" | "missed_call" | "ai_intake" | "calendar" | "dashboard" | "cta";

export interface Scene {
  durationSec: number;
  headline: string;
  subtext?: string;
  kicker?: string;
  highlight?: string;
  dataPoints?: { label: string; value: string }[];
  bgImageUrl?: string;
  visual?: SceneVisual;
}

export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface LoomProps {
  [key: string]: unknown;
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
    ctaUrl?: string;
    ctaLabel?: string;
    captions?: CaptionCue[];
    scenes: Scene[];
  };
}

const INK = "#f5f8ff";
const INK_SOFT = "#d8e1ef";
const INK_MUTED = "#91a4bd";
const STAGE_BG = "#08111f";
const PANEL = "#101a2b";
const PANEL_2 = "#152237";
const LINE = "rgba(255,255,255,0.12)";

export const LoomVideo: React.FC<LoomProps> = ({ spec, audioFile, fps }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const accent = readableAccent(spec.accent);
  const scenes = spec.scenes.length ? spec.scenes : [{ durationSec: durationInFrames / fps, headline: spec.title, visual: "cta" as const }];
  let acc = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: STAGE_BG, fontFamily: FONT }}>
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
      {scenes.map((scene, i) => {
        const from = acc;
        const df = Math.max(1, Math.round(scene.durationSec * fps));
        acc += df;
        return (
          <Sequence key={i} from={from} durationInFrames={df}>
            <SceneView scene={scene} accent={accent} spec={spec} index={i} sceneFrames={df} isLast={i === scenes.length - 1} />
          </Sequence>
        );
      })}
      <TopBar spec={spec} accent={accent} />
      <VoiceOrb accent={accent} />
      <CaptionOverlay captions={spec.captions ?? []} accent={accent} />
      <div style={{ position: "absolute", left: 0, bottom: 0, height: 4, width: "100%", background: "rgba(255,255,255,0.08)" }}>
        <div style={{ height: "100%", width: `${(frame / Math.max(1, durationInFrames)) * 100}%`, background: accent, boxShadow: `0 0 12px ${hexToRgba(accent, 0.75)}` }} />
      </div>
    </AbsoluteFill>
  );
};

const AmbientStage: React.FC<{ accent: string }> = ({ accent }) => {
  return (
    <AbsoluteFill
      style={{
        background:
          `linear-gradient(150deg, #0a1424 0%, #09111f 42%, #060a12 100%),` +
          `linear-gradient(90deg, ${hexToRgba(accent, 0.12)}, transparent 38%, rgba(59,130,246,0.08))`,
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage: "linear-gradient(120deg, black 10%, transparent 88%)",
          WebkitMaskImage: "linear-gradient(120deg, black 10%, transparent 88%)",
        }}
      />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(255,255,255,0.02), transparent 28%, rgba(0,0,0,0.18))" }} />
    </AbsoluteFill>
  );
};

const TopBar: React.FC<{ spec: LoomProps["spec"]; accent: string }> = ({ spec, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 4, fps, config: { damping: 200 } });
  const y = interpolate(enter, [0, 1], [-22, 0]);
  return (
    <div style={{ position: "absolute", top: 26, left: 40, right: 40, display: "flex", justifyContent: "space-between", alignItems: "center", transform: `translateY(${y}px)`, opacity: enter }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(8,14,26,0.78)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 999, padding: "7px 18px 7px 9px" }}>
        {spec.logoUrl ? (
          <Img src={assetSrc(spec.logoUrl)} style={{ width: 32, height: 32, borderRadius: 8, objectFit: "contain", background: "rgba(255,255,255,0.94)", padding: 3 }} />
        ) : (
          <span style={{ width: 11, height: 11, marginLeft: 6, borderRadius: 99, background: accent, boxShadow: `0 0 14px ${accent}` }} />
        )}
        <span style={{ fontSize: 19, fontWeight: 800, color: INK, letterSpacing: 0 }}>{spec.companyName ?? "Personalized video"}</span>
      </div>
      {spec.prospectName ? (
        <div style={{ display: "flex", alignItems: "center", gap: 9, background: "rgba(8,14,26,0.78)", border: `1px solid ${hexToRgba(accent, 0.45)}`, borderRadius: 999, padding: "8px 16px", fontSize: 16, fontWeight: 700, color: INK }}>
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
  const exit = isLast ? 1 : interpolate(frame, [sceneFrames - 12, sceneFrames - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const requestedVisual = scene.visual ?? defaultVisual(index, isLast, Boolean(scene.bgImageUrl));
  const visual = requestedVisual === "website" && !scene.bgImageUrl ? "missed_call" : requestedVisual;
  const showWebsite = visual === "website" && Boolean(scene.bgImageUrl);
  const hasVisual = showWebsite || visual !== "website";

  return (
    <AbsoluteFill style={{ opacity: exit, transform: `translateY(${(1 - exit) * -18}px)` }}>
      <div style={{ position: "absolute", top: 96, bottom: 116, left: 64, right: 64, display: "flex", alignItems: "center", gap: 42 }}>
        <div style={{ flex: hasVisual ? "0 0 43%" : "1 1 auto", maxWidth: hasVisual ? 560 : 920, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {scene.kicker ? <Kicker text={scene.kicker} accent={accent} /> : null}
          <StaggeredHeadline text={scene.headline} accent={accent} highlight={scene.highlight} compact={hasVisual} />
          {scene.subtext ? <Subtext text={scene.subtext} compact={hasVisual} /> : null}
          {scene.dataPoints?.length && !(isLast && spec.ctaUrl) ? <DataPoints points={scene.dataPoints} accent={accent} /> : null}
          {isLast && spec.ctaUrl ? <CtaButton url={spec.ctaUrl} label={spec.ctaLabel} accent={accent} /> : null}
        </div>
        {hasVisual ? (
          <div style={{ flex: "1 1 57%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {showWebsite ? (
              <WebsiteCard src={scene.bgImageUrl!} accent={accent} websiteUrl={spec.websiteUrl} sceneFrames={sceneFrames} />
            ) : (
              <ProductVisual kind={visual} accent={accent} companyName={spec.companyName} ctaUrl={spec.ctaUrl} ctaLabel={spec.ctaLabel} />
            )}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

function defaultVisual(index: number, isLast: boolean, hasWebsite: boolean): SceneVisual {
  if (isLast) return "cta";
  if (index === 0 && hasWebsite) return "website";
  return (["missed_call", "ai_intake", "calendar", "dashboard"] as SceneVisual[])[Math.min(index, 3)];
}

const ProductVisual: React.FC<{
  kind: SceneVisual;
  accent: string;
  companyName?: string;
  ctaUrl?: string;
  ctaLabel?: string;
}> = ({ kind, accent, companyName, ctaUrl, ctaLabel }) => {
  if (kind === "missed_call") return <MissedCallPanel accent={accent} companyName={companyName} />;
  if (kind === "ai_intake") return <AiIntakePanel accent={accent} companyName={companyName} />;
  if (kind === "calendar") return <CalendarPanel accent={accent} companyName={companyName} />;
  if (kind === "dashboard") return <DashboardPanel accent={accent} companyName={companyName} />;
  return <CtaPanel accent={accent} companyName={companyName} ctaUrl={ctaUrl} ctaLabel={ctaLabel} />;
};

const MockShell: React.FC<{ children: React.ReactNode; accent: string; title: string }> = ({ children, accent, title }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 6, fps, config: { damping: 18, mass: 0.9 } });
  return (
    <div style={{ width: "100%", maxWidth: 650, background: "rgba(12,20,34,0.88)", border: `1px solid ${hexToRgba(accent, 0.34)}`, borderRadius: 8, boxShadow: `0 30px 90px rgba(0,0,0,0.46), 0 0 50px ${hexToRgba(accent, 0.1)}`, padding: 22, opacity: enter, transform: `translateY(${(1 - enter) * 28}px) scale(${0.97 + enter * 0.03})` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div style={{ color: INK, fontSize: 22, fontWeight: 900 }}>{title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, color: accent, fontSize: 14, fontWeight: 900, textTransform: "uppercase" }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: accent, boxShadow: `0 0 10px ${accent}` }} />
          Live
        </div>
      </div>
      {children}
    </div>
  );
};

const MissedCallPanel: React.FC<{ accent: string; companyName?: string }> = ({ accent, companyName }) => {
  const frame = useCurrentFrame();
  const ring = 1 + Math.sin(frame / 5) * 0.028;
  return (
    <MockShell accent={accent} title="Incoming lead">
      <div style={{ display: "grid", gridTemplateColumns: "190px 1fr", gap: 20, alignItems: "center" }}>
        <div style={{ height: 336, borderRadius: 8, background: "#050a13", border: "1px solid rgba(255,255,255,0.1)", padding: 16, display: "flex", flexDirection: "column", transform: `scale(${ring})` }}>
          <div style={{ color: INK_MUTED, fontSize: 13, fontWeight: 800, display: "flex", justifyContent: "space-between" }}>
            <span>9:42</span>
            <span>Missed</span>
          </div>
          <div style={{ marginTop: 36, textAlign: "center" }}>
            <div style={{ margin: "0 auto", width: 88, height: 88, borderRadius: 99, border: "2px solid rgba(248,113,113,0.7)", background: "rgba(127,29,29,0.46)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fecaca", fontSize: 44, fontWeight: 900 }}>!</div>
            <div style={{ marginTop: 22, color: INK, fontSize: 24, fontWeight: 900 }}>New homeowner</div>
            <div style={{ color: INK_MUTED, fontSize: 16, marginTop: 8 }}>{companyName ?? "Your team"}</div>
          </div>
          <div style={{ marginTop: "auto", borderRadius: 8, background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.28)", padding: 12, color: "#fee2e2", fontSize: 15, lineHeight: 1.2, fontWeight: 800 }}>
            "Can someone come out today?"
          </div>
        </div>
        <div style={{ display: "grid", gap: 13 }}>
          <StatusRow color="#ef4444" label="Call went to voicemail" />
          <StatusRow color="#f59e0b" label="No intake captured" />
          <StatusRow color={INK_MUTED} label="Competitor answers first" />
        </div>
      </div>
    </MockShell>
  );
};

const AiIntakePanel: React.FC<{ accent: string; companyName?: string }> = ({ accent, companyName }) => (
  <MockShell accent={accent} title="AI receptionist">
    <div style={{ display: "grid", gap: 13 }}>
      <TranscriptLine who="AI" text={`Thanks for calling ${companyName ?? "the team"}. I can help get this scheduled.`} accent={accent} />
      <TranscriptLine who="Caller" text="I have a leak. I need someone to look at it." accent="#60a5fa" />
      <TranscriptLine who="AI" text="What is the address and best callback number?" accent={accent} />
      <TranscriptLine who="AI" text="I found an opening tomorrow morning and can book it now." accent={accent} />
      <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <MiniMetric label="Answered" value="<30s" accent={accent} />
        <MiniMetric label="Qualified" value="Yes" accent={accent} />
        <MiniMetric label="Routed" value="Team" accent={accent} />
      </div>
    </div>
  </MockShell>
);

const CalendarPanel: React.FC<{ accent: string; companyName?: string }> = ({ accent }) => (
  <MockShell accent={accent} title="Booked appointment">
    <div style={{ display: "grid", gridTemplateColumns: "1fr 170px", gap: 18 }}>
      <div>
        <div style={{ border: `1px solid ${hexToRgba(accent, 0.52)}`, background: hexToRgba(accent, 0.12), borderRadius: 8, padding: 20 }}>
          <div style={{ color: accent, fontSize: 18, fontWeight: 900 }}>Tomorrow, 10:30 AM</div>
          <div style={{ color: INK, fontSize: 32, fontWeight: 900, marginTop: 8 }}>Roof estimate</div>
          <div style={{ color: INK_SOFT, fontSize: 19, lineHeight: 1.28, marginTop: 8 }}>Confirmation text sent. Team notification delivered.</div>
        </div>
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {["Address saved", "Need summarized", "Caller qualified", "Lead logged"].map((item) => (
            <div key={item} style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${LINE}`, borderRadius: 8, padding: "11px 12px", color: INK_SOFT, fontSize: 16, fontWeight: 800 }}>
              {item}
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateRows: "44px repeat(4, 1fr)", gap: 8 }}>
        <div style={{ color: INK_MUTED, fontSize: 14, fontWeight: 900, textAlign: "center" }}>CALENDAR</div>
        {["8:30", "10:30", "1:00", "3:30"].map((time) => (
          <div key={time} style={{ borderRadius: 8, border: `1px solid ${time === "10:30" ? hexToRgba(accent, 0.58) : LINE}`, background: time === "10:30" ? hexToRgba(accent, 0.15) : "rgba(255,255,255,0.04)", color: time === "10:30" ? accent : INK_MUTED, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900 }}>
            {time}
          </div>
        ))}
      </div>
    </div>
  </MockShell>
);

const DashboardPanel: React.FC<{ accent: string; companyName?: string }> = ({ accent, companyName }) => (
  <MockShell accent={accent} title={`${companyName ?? "Owner"} dashboard`}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 14 }}>
      <MiniMetric label="Calls" value="12" accent={accent} />
      <MiniMetric label="Texts" value="28" accent="#60a5fa" />
      <MiniMetric label="Booked" value="4" accent="#34d399" />
    </div>
    <div style={{ background: "rgba(255,255,255,0.05)", border: `1px solid ${LINE}`, borderRadius: 8, padding: 16 }}>
      {[
        ["10:30 AM", "Roof estimate booked", "Ready"],
        ["9:58 AM", "New caller summary", "Sent"],
        ["8:41 AM", "After-hours lead", "Followed up"],
      ].map(([time, title, status]) => (
        <div key={time} style={{ display: "grid", gridTemplateColumns: "94px 1fr 104px", gap: 12, color: INK_SOFT, fontSize: 16, padding: "11px 0", borderTop: time === "10:30 AM" ? "none" : "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ color: INK_MUTED }}>{time}</div>
          <div style={{ fontWeight: 800 }}>{title}</div>
          <div style={{ color: "#a7f3d0", fontWeight: 900 }}>{status}</div>
        </div>
      ))}
    </div>
  </MockShell>
);

const CtaPanel: React.FC<{ accent: string; companyName?: string; ctaUrl?: string; ctaLabel?: string }> = ({ accent, companyName, ctaUrl, ctaLabel }) => (
  <MockShell accent={accent} title="Walkthrough ready">
    <div style={{ display: "grid", gap: 13 }}>
      <StatusRow color={accent} label={`Mapped for ${companyName ?? "your call flow"}`} />
      <StatusRow color="#60a5fa" label="Shows missed-call recovery live" />
      <StatusRow color="#34d399" label="Ends with booked appointment proof" />
      {ctaUrl ? <CtaButton url={ctaUrl} label={ctaLabel} accent={accent} /> : null}
    </div>
  </MockShell>
);

const TranscriptLine: React.FC<{ who: string; text: string; accent: string }> = ({ who, text, accent }) => (
  <div style={{ display: "grid", gridTemplateColumns: "78px 1fr", gap: 12, alignItems: "start", background: "rgba(255,255,255,0.055)", border: `1px solid ${LINE}`, borderRadius: 8, padding: 13 }}>
    <div style={{ color: accent, fontSize: 15, fontWeight: 900 }}>{who}</div>
    <div style={{ color: INK, fontSize: 18, lineHeight: 1.25, fontWeight: 700 }}>{text}</div>
  </div>
);

const MiniMetric: React.FC<{ label: string; value: string; accent: string }> = ({ label, value, accent }) => (
  <div style={{ background: "rgba(255,255,255,0.055)", border: `1px solid ${LINE}`, borderRadius: 8, padding: 13 }}>
    <div style={{ color: INK_MUTED, fontSize: 13, fontWeight: 900, textTransform: "uppercase" }}>{label}</div>
    <div style={{ color: accent, fontSize: 30, fontWeight: 900, marginTop: 3 }}>{value}</div>
  </div>
);

const StatusRow: React.FC<{ label: string; color: string }> = ({ label, color }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(255,255,255,0.055)", border: `1px solid ${LINE}`, borderRadius: 8, padding: "14px 16px", color: INK, fontSize: 20, fontWeight: 850 }}>
    <div style={{ width: 12, height: 12, borderRadius: 99, backgroundColor: color, boxShadow: `0 0 12px ${hexToRgba(color, 0.55)}` }} />
    {label}
  </div>
);

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

const StaggeredHeadline: React.FC<{ text: string; accent: string; highlight?: string; compact: boolean }> = ({ text, accent, highlight, compact }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const size = fitHeadline(text, compact);
  const hl = (highlight ?? "").trim().toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
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
    <div style={{ fontSize: size, lineHeight: 1.06, fontWeight: 900, letterSpacing: 0, color: INK, textShadow: "0 6px 30px rgba(0,0,0,0.5)" }}>
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
              textShadow: isHl ? `0 0 24px ${hexToRgba(accent, 0.42)}` : undefined,
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
    <div style={{ marginTop: 16, fontSize: fitSubtext(text, compact), lineHeight: 1.3, fontWeight: 600, color: INK_MUTED, maxWidth: 620, opacity: enter, transform: `translateY(${(1 - enter) * 12}px)` }}>
      {text}
    </div>
  );
};

const DataPoints: React.FC<{ points: { label: string; value: string }[]; accent: string }> = ({ points, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", gap: 14, marginTop: 28, flexWrap: "wrap" }}>
      {points.slice(0, 2).map((d, i) => {
        const enter = spring({ frame: frame - 16 - i * 4, fps, config: { damping: 15, mass: 0.8 } });
        return (
          <div key={i} style={{ minWidth: 178, maxWidth: 250, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "16px 18px 14px", boxShadow: "0 16px 40px rgba(0,0,0,0.28)", opacity: enter, transform: `translateY(${(1 - enter) * 22}px) scale(${0.94 + enter * 0.06})` }}>
            <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: 0, color: accent }}>
              <CountUpValue value={d.value} startFrame={16 + i * 4} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: INK_MUTED, marginTop: 3 }}>{d.label}</div>
            <div style={{ height: 3, width: 44, background: accent, borderRadius: 2, marginTop: 10, opacity: 0.9 }} />
          </div>
        );
      })}
    </div>
  );
};

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

const WebsiteCard: React.FC<{ src: string; accent: string; websiteUrl?: string; sceneFrames: number }> = ({ src, accent, websiteUrl, sceneFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 5, fps, config: { damping: 18, mass: 0.9 } });
  const float = Math.sin((frame / fps) * 1.15) * 4;
  const scroll = interpolate(frame, [10, Math.max(11, sceneFrames - 6)], [0, 48], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        opacity: enter,
        transform: `perspective(1400px) rotateY(-3deg) translateX(${(1 - enter) * 70}px) translateY(${float}px)`,
        borderRadius: 8,
        overflow: "hidden",
        border: `1px solid ${hexToRgba(accent, 0.42)}`,
        boxShadow: `0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05), 0 0 60px ${hexToRgba(accent, 0.12)}`,
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
          <span style={{ marginLeft: 12, display: "flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,0.07)", borderRadius: 8, padding: "4px 12px", color: "#c3cede", fontSize: 14, fontWeight: 600 }}>
            {websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </span>
        ) : null}
      </div>
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <Img src={assetSrc(src)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: `50% ${scroll}%`, filter: "saturate(0.96) contrast(1.02)" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(5,9,17,0.04), rgba(5,9,17,0.24) 72%, rgba(5,9,17,0.5))" }} />
      </div>
    </div>
  );
};

const CtaButton: React.FC<{ url: string; label?: string; accent: string }> = ({ url, label, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 20, fps, config: { damping: 14, mass: 0.8 } });
  const pulse = 1 + Math.sin((frame / fps) * 2.6) * 0.012;
  const domain = url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const onAccent = idealTextColor(accent);
  return (
    <div style={{ marginTop: 30, display: "flex", alignItems: "center", gap: 16, opacity: enter, transform: `translateY(${(1 - enter) * 24}px)` }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 12, background: accent, color: onAccent, borderRadius: 8, padding: "16px 24px", fontSize: 22, fontWeight: 900, letterSpacing: 0, boxShadow: `0 14px 44px ${hexToRgba(accent, 0.42)}, 0 0 0 ${Math.max(0, Math.sin((frame / fps) * 2.6)) * 7}px ${hexToRgba(accent, 0.14)}`, transform: `scale(${pulse})` }}>
        {label ?? "Book a quick demo"}
        <span style={{ fontSize: 23, lineHeight: 1 }}>{"->"}</span>
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: INK_MUTED }}>{domain}</div>
    </div>
  );
};

const VoiceOrb: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 8, fps, config: { damping: 200 } });
  const t = frame / fps;
  const bars = [0, 1, 2, 3, 4].map((i) => 8 + Math.abs(Math.sin(t * (3.1 + i * 0.83) + i * 1.7)) * 15);
  return (
    <div style={{ position: "absolute", left: 40, bottom: 30, display: "flex", alignItems: "center", gap: 13, opacity: enter, transform: `translateY(${(1 - enter) * 20}px)` }}>
      <div style={{ width: 58, height: 58, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", gap: 3, background: PANEL, border: `1.5px solid ${hexToRgba(accent, 0.55)}`, boxShadow: `0 0 22px ${hexToRgba(accent, 0.28)}` }}>
        {bars.map((h, i) => (
          <span key={i} style={{ width: 3.5, height: h, borderRadius: 3, background: INK, opacity: 0.92 }} />
        ))}
      </div>
      <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1.6, color: INK_MUTED, textTransform: "uppercase" }}>Audio on</span>
    </div>
  );
};

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
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 25, pointerEvents: "none" }}>
      <div style={{ maxWidth: 880, textAlign: "center", background: "rgba(7,12,22,0.88)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "12px 24px", fontSize: fitCaption(cue.text), lineHeight: 1.25, fontWeight: 800, boxShadow: "0 16px 44px rgba(0,0,0,0.45)", opacity: pop, transform: `translateY(${(1 - pop) * 12}px) scale(${0.97 + pop * 0.03})` }}>
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

function fitHeadline(text: string, compact: boolean): number {
  const base = compact ? 54 : 66;
  if (text.length > 86) return compact ? 35 : 42;
  if (text.length > 64) return compact ? 41 : 50;
  if (text.length > 44) return compact ? 47 : 58;
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

function readableAccent(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  if (s < 0.12) return ensureContrast("#22c55e", STAGE_BG, 5.5);
  const vivid = hslToHex(h, Math.max(s, 0.55), Math.max(l, 0.5));
  return ensureContrast(vivid, STAGE_BG, 5.5);
}

function idealTextColor(bg: string): string {
  return relLuminance(hexToRgb(bg)) < 0.45 ? "#f6f9ff" : "#0b1118";
}

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
