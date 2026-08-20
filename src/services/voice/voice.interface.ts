/**
 * The two seams of the voice channel, kept as interfaces for the same reason
 * `EmailSender` is one: business logic must never reach for a vendor SDK.
 *
 *   TelephonyProvider — who carries the audio (Twilio today).
 *   RealtimeVoice     — who thinks and speaks (OpenAI Realtime today).
 *
 * The media bridge is the only code that knows both exist, and it only knows
 * these shapes. Swapping in Telnyx, or a Deepgram→LLM→ElevenLabs pipeline in
 * place of a speech-to-speech model, means adding a file here — not touching
 * the dialer, the script, the compliance gate, or the analysis.
 */

/** A function the model can call mid-conversation. */
export interface RealtimeTool {
  name: string;
  description: string;
  /** JSON Schema (OpenAI function-tool format). */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface RealtimeCallbacks {
  /** Base64 G.711 μ-law from the model, ready to hand to the carrier. */
  onAudio(base64Mulaw: string): void;
  /**
   * The prospect started talking. Whether this is a real barge-in depends on
   * whether OUR audio is still playing at the carrier, which only the bridge
   * knows — so this fires unconditionally and the bridge decides.
   */
  onInterrupt(): void;
  onTranscript(role: "agent" | "prospect", text: string): void;
  onError(err: unknown): void;
  onClose(): void;
  /**
   * The session the server actually resolved, echoed back on `session.updated`.
   * Optional, and worth listening to: a rejected or unsupported audio setting is
   * dropped silently, so this is the only way to confirm what is really in force.
   */
  onSessionUpdated?(session: Record<string, unknown>): void;
}

export interface RealtimeSessionOptions {
  instructions: string;
  tools: RealtimeTool[];
  callbacks: RealtimeCallbacks;
  /** Speak first without waiting to be spoken to (an outbound call opener). */
  greetFirst?: boolean;
  /** Override the configured session schema — used by preflight to probe both. */
  schema?: "ga" | "beta";
  /** Override the configured model, for probing one specific voice/model. */
  model?: string;
  /** Override the configured voice — used to audition voices side by side. */
  voice?: string;
}

export interface RealtimeSession {
  /** Push base64 μ-law captured from the phone line. */
  sendAudio(base64Mulaw: string): void;
  /** Inject an out-of-band instruction mid-call (e.g. "wrap up now"). */
  nudge(instruction: string): void;
  /** Stop the in-flight response — the model half of a barge-in. */
  cancelResponse(): void;
  close(): void;
  readonly closed: boolean;
}

export interface PlaceCallRequest {
  to: string;
  from: string;
  /** Our Call._id — the carrier echoes it back on webhooks. */
  callId: string;
  /** Public URL the carrier fetches for call control (TwiML). */
  answerUrl: string;
  statusUrl: string;
  record: boolean;
}

export interface PlaceCallResult {
  providerCallId: string;
  detail?: string;
}

export interface TelephonyProvider {
  readonly name: string;
  configured(): boolean;
  placeCall(req: PlaceCallRequest): Promise<PlaceCallResult>;
  hangup(providerCallId: string): Promise<void>;
  /** Warm transfer to a human. Throws if the provider can't do it. */
  transfer(providerCallId: string, toNumber: string): Promise<void>;
}
