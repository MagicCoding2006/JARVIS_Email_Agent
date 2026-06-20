import React from "react";
import { Composition } from "remotion";
import { LoomVideo, type LoomProps } from "./LoomVideo";

const DEFAULT_PROPS: LoomProps = {
  fps: 30,
  durationInFrames: 240,
  audioFile: "",
  spec: {
    title: "Quick intro",
    accent: "#4f46e5",
    scenes: [{ durationSec: 8, headline: "A quick idea for your team", subtext: "30 seconds, promise." }],
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
