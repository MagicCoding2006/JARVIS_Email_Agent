import React from "react";
import { Composition } from "remotion";
import { LoomVideo, type LoomProps } from "./LoomVideo";

const DEFAULT_PROPS: LoomProps = {
  fps: 30,
  durationInFrames: 480,
  audioFile: "",
  spec: {
    title: "Quick intro",
    accent: "#4f46e5",
    prospectName: "Mike",
    companyName: "Acme Roofing",
    ctaUrl: "https://calendly.com/you/intro",
    ctaLabel: "Book a 15-min demo",
    scenes: [
      { durationSec: 8, headline: "Acme Roofing, you're losing jobs.", highlight: "losing jobs", subtext: "Missing just 3 calls a week", dataPoints: [{ label: "Lost revenue", value: "$30,000" }] },
      { durationSec: 8, kicker: "The ask", headline: "Turn missed calls into jobs.", highlight: "jobs", subtext: "See it live, 15 minutes." },
    ],
  },
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      schema={undefined}
      id="LoomVideo"
      component={LoomVideo as unknown as React.FC<Record<string, unknown>>}
      durationInFrames={DEFAULT_PROPS.durationInFrames}
      fps={DEFAULT_PROPS.fps}
      width={1280}
      height={720}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={({ props }) => ({
        durationInFrames: Number(props.durationInFrames) || DEFAULT_PROPS.durationInFrames,
        fps: Number(props.fps) || DEFAULT_PROPS.fps,
      })}
    />
  );
};
