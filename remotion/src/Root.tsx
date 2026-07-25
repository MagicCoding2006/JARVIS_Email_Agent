import React from "react";
import { Composition } from "remotion";
import { LoomVideo, type LoomProps } from "./LoomVideo";

const DEFAULT_PROPS = {
  fps: 30,
  durationInFrames: 540,
  audioFile: "",
  spec: {
    title: "Acme Roofing missed-call demo",
    accent: "#22c55e",
    prospectName: "Mike",
    companyName: "Acme Roofing",
    websiteUrl: "https://acmeroofing.example",
    ctaUrl: "https://calendly.com/you/intro",
    ctaLabel: "Book a 15-min walkthrough",
    scenes: [
      {
        durationSec: 4,
        headline: "Acme Roofing, missed calls cost jobs",
        highlight: "cost jobs",
        subtext: "A personalized look at the calls that slip past the team.",
        visual: "website",
      },
      {
        durationSec: 4,
        kicker: "The leak",
        headline: "Voicemail loses the buyer",
        highlight: "Voicemail",
        subtext: "The first contractor to answer usually gets the inspection.",
        visual: "missed_call",
      },
      {
        durationSec: 4,
        kicker: "The fix",
        headline: "AI answers and qualifies",
        highlight: "qualifies",
        subtext: "It captures the issue, address, and callback number instantly.",
        visual: "ai_intake",
      },
      {
        durationSec: 4,
        kicker: "Booked",
        headline: "The job hits your calendar",
        highlight: "calendar",
        subtext: "The caller gets confirmation. Your team gets the details.",
        visual: "calendar",
      },
      {
        durationSec: 2,
        kicker: "Next step",
        headline: "See it on your workflow",
        highlight: "your workflow",
        subtext: "A quick walkthrough, no rebuild required.",
        visual: "cta",
      },
    ],
  },
} satisfies LoomProps;

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
