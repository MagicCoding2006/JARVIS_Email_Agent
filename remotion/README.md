# Remotion video renderer

Renders Loom-style sales videos from a GLM-generated **scene spec** + a **Gemini TTS**
voiceover. Driven by props (no model-generated code is executed).

## One-time setup

```bash
cd remotion
npm install
```

Then in the main project's `.env`:

```
GEMINI_API_KEY=...            # required for the voiceover
VIDEO_ENABLE_REMOTION=true    # turn on the render step
```

## How it's used

The main app calls `produceVideo(videoId)`:

1. `synthesizeVoiceover()` → Gemini TTS → `data/videos/<id>.wav`
2. `generateSceneSpec()` → GLM acts as creative director → JSON spec
3. `renderWithRemotion()` → copies the wav into `public/`, writes props to `out/`,
   runs `npx remotion render LoomVideo …` → `data/videos/<id>.mp4`

## Develop the look

```bash
npm run studio        # live-edit LoomVideo.tsx against default props
```

Edit `src/LoomVideo.tsx` (scenes, animations, branding). The composition reads
`{ spec, audioFile, fps, durationInFrames }` from props.

## Alternative backends

To use HeyGen / ElevenLabs / **Higgsfield MCP** instead, implement the
`VideoRenderer` interface in `src/services/video.service.ts` and call
`renderVideo()` — you can skip this sub-project entirely.
