/**
 * Flatten a Telegram message into something worth listening to.
 *
 * Agent replies are written for a screen: markdown, bare URLs, emoji, and the
 * ASCII tables the CRM view emits. Read verbatim those become long strings of
 * punctuation, so strip them before synthesis and cap the length — synthesis is
 * CPU-bound, and nobody wants a four-minute voice note anyway.
 */
export function toSpeech(text: string, maxChars: number): string {
  let s = text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "link")
    .replace(/https?:\/\/\S+/g, "link")
    // Table rows and rule lines: pure punctuation once read aloud.
    .replace(/^\s*\|.*$/gm, "")
    .replace(/^\s*[-+=_*|]{3,}\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|\s)_([^_\n]+)_/g, "$1$2")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    // Prefer a clean sentence break, but only if it isn't lopping off most of it.
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
    s = `${(stop > maxChars * 0.6 ? cut.slice(0, stop + 1) : cut).trim()} That's the short version.`;
  }
  return s;
}
