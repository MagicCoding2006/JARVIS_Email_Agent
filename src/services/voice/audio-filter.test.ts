import assert from "node:assert/strict";
import test from "node:test";

process.env.MONGODB_URI ??= "mongodb://localhost:27017/jarvis-test";

const { muLawDecode, muLawEncode, VoiceHumanizer, createHumanizer } = await import("./audio-filter.js");

test("mu-law round trip preserves every sample value", () => {
  // The filter decodes, processes, and re-encodes every frame, so a lossy round
  // trip would degrade the audio on every call for no benefit.
  //
  // Asserted on the SAMPLE, not the byte: μ-law encodes zero twice (0x7F = −0,
  // 0xFF = +0) and encoding normalizes to 0xFF. Inaudible, but it makes
  // byte-equality the wrong test.
  for (let byte = 0; byte < 256; byte++) {
    const sample = muLawDecode(byte);
    assert.equal(muLawDecode(muLawEncode(sample)), sample, `byte ${byte} (sample ${sample}) round-trips`);
  }
});

test("the two zero codes are the only bytes that are not bit-stable", () => {
  const unstable = [];
  for (let byte = 0; byte < 256; byte++) {
    if (muLawEncode(muLawDecode(byte)) !== byte) unstable.push(byte);
  }
  assert.deepEqual(unstable, [0x7f], "only negative zero normalizes");
});

test("a no-op humanizer leaves the audio unchanged", () => {
  const passthrough = new VoiceHumanizer({ comfortNoiseDb: -Infinity, driveDb: 0 });
  const frame = Buffer.from(Array.from({ length: 160 }, (_, i) => i));
  const out = passthrough.process(frame);
  for (let i = 0; i < frame.length; i++) {
    assert.equal(muLawDecode(out[i]), muLawDecode(frame[i]), `sample ${i} unchanged`);
  }
});

test("createHumanizer returns null when it would do nothing", () => {
  assert.equal(createHumanizer({ enabled: false, comfortNoiseDb: -50, driveDb: 3 }), null);
  assert.equal(createHumanizer({ enabled: true, comfortNoiseDb: -120, driveDb: 0 }), null);
  assert.ok(createHumanizer({ enabled: true, comfortNoiseDb: -120, driveDb: 0, compressPauses: true }));
  assert.ok(createHumanizer({ enabled: true, comfortNoiseDb: -120, driveDb: 0, fastStart: true }));
  assert.ok(createHumanizer({ enabled: true, comfortNoiseDb: -120, driveDb: 0, clarityDb: 1.5 }));
  assert.ok(createHumanizer({ enabled: true, comfortNoiseDb: -50, driveDb: 0 }));
});

test("comfort noise fills silence without becoming audible hiss", () => {
  const h = new VoiceHumanizer({ comfortNoiseDb: -55, driveDb: 0 });
  const silence = Buffer.alloc(400, muLawEncode(0));
  const processed = h.process(silence);

  const levels = [...processed].map((b) => Math.abs(muLawDecode(b)));
  const peak = Math.max(...levels);
  assert.ok(peak > 0, "silence is no longer mathematically dead");
  // -55dBFS is ~58/32767. Anything near speech level would be a bug.
  assert.ok(peak < 1200, `noise bed stays well below speech (peak ${peak})`);
});

test("drive adds presence without wrapping the waveform", () => {
  const h = new VoiceHumanizer({ comfortNoiseDb: -Infinity, driveDb: 12 });
  // A loud tone: naive gain would overflow and invert the sign, which sounds
  // like tearing. The soft limiter must keep polarity and stay in range.
  const loud = Buffer.from([...Array(80)].map((_, i) => muLawEncode(i % 2 ? 24000 : -24000)));
  const processed = h.process(loud);

  for (let i = 0; i < processed.length; i++) {
    const before = muLawDecode(loud[i]);
    const after = muLawDecode(processed[i]);
    assert.equal(Math.sign(after), Math.sign(before), `sample ${i} keeps its polarity`);
    assert.ok(Math.abs(after) <= 32767, `sample ${i} stays in range`);
  }
});

test("clarity lift preserves polarity and sample range", () => {
  const h = new VoiceHumanizer({ comfortNoiseDb: -Infinity, driveDb: 0, clarityDb: 3 });
  const ramp = Buffer.from([...Array(160)].map((_, i) => muLawEncode((i % 40) * 250 - 5000)));
  const processed = h.process(ramp);

  assert.equal(processed.length, ramp.length);
  for (const byte of processed) {
    assert.ok(Math.abs(muLawDecode(byte)) <= 32767);
  }
});

test("clarity set to zero keeps the no-op path unchanged", () => {
  const h = new VoiceHumanizer({ comfortNoiseDb: -Infinity, driveDb: 0, clarityDb: 0 });
  const frame = Buffer.from(Array.from({ length: 160 }, (_, i) => i));
  const out = h.process(frame);
  for (let i = 0; i < frame.length; i++) {
    assert.equal(muLawDecode(out[i]), muLawDecode(frame[i]), `sample ${i} unchanged`);
  }
});

test("output frame length always matches the input frame", () => {
  const h = new VoiceHumanizer({ comfortNoiseDb: -50, driveDb: 4 });
  for (const size of [1, 160, 320]) {
    assert.equal(h.process(Buffer.alloc(size, 0xff)).length, size);
  }
});

test("pause compression shortens sustained silence after the preserved lead-in", () => {
  const h = new VoiceHumanizer({
    comfortNoiseDb: -Infinity,
    driveDb: 0,
    compressPauses: true,
    pauseKeepMs: 40,
    pauseThresholdDb: -48,
  });
  const silence = Buffer.alloc(160, muLawEncode(0)); // 20ms
  const lengths = Array.from({ length: 9 }, () => h.process(silence).length);

  assert.deepEqual(lengths.slice(0, 2), [160, 160], "the first 40ms of silence is preserved");
  assert.ok(lengths.some((n) => n === 0), "later quiet frames are dropped");
  assert.ok(lengths.some((n, i) => i > 2 && n === 160), "some quiet frames remain as room tone");
});

test("pause compression does not drop voiced frames", () => {
  const h = new VoiceHumanizer({
    comfortNoiseDb: -Infinity,
    driveDb: 0,
    compressPauses: true,
    pauseKeepMs: 0,
    pauseThresholdDb: -48,
  });
  const speech = Buffer.from([...Array(12)].map((_, i) => muLawEncode(i % 2 ? 8000 : -8000)));

  for (let i = 0; i < 12; i++) {
    assert.equal(h.process(speech).length, speech.length, `voiced frame ${i} is preserved`);
  }
});

test("fast start drops only some early frames and preserves the opening attack", () => {
  const h = new VoiceHumanizer({
    comfortNoiseDb: -Infinity,
    driveDb: 0,
    fastStart: true,
    fastStartMs: 140,
    fastStartRate: 1.3,
  });
  const speech = Buffer.from([...Array(160)].map((_, i) => muLawEncode(i % 2 ? 8000 : -8000)));
  const lengths = Array.from({ length: 12 }, () => h.process(speech).length);

  assert.deepEqual(lengths.slice(0, 2), [160, 160], "first 40ms stays intact");
  assert.ok(lengths.slice(2, 7).some((n) => n === 0), "some early frames are dropped");
  assert.ok(lengths.slice(8).every((n) => n === 160), "later frames are untouched");
});
