import { schema, type Tool } from "./types.js";
import { listRepoDir, readRepoFile, proposeChange, websiteRepoEnabled } from "../../services/github.service.js";
import { notify } from "../../services/notifications.service.js";

const NOT_CONNECTED = { error: "website repo not connected — ask the operator to set GITHUB_TOKEN + WEBSITE_REPO" };

export const listSiteFiles: Tool = {
  name: "list_site_files",
  description: "List files/directories in the marketing website's GitHub repo (the page prospects land on after clicking).",
  risk: "low",
  parameters: schema({ path: { type: "string", description: "Directory path (default repo root)" } }),
  async run(args: { path?: string }) {
    if (!websiteRepoEnabled()) return NOT_CONNECTED;
    return { entries: await listRepoDir(args.path ?? "") };
  },
};

export const readSiteFile: Tool = {
  name: "read_site_file",
  description:
    "Read a file from the website repo. Large files are windowed — use startLine to page through, and NEVER rewrite a file you've only partially seen (use propose_site_change's find/replace mode instead).",
  risk: "low",
  parameters: schema(
    {
      path: { type: "string" },
      startLine: { type: "number", description: "1-based first line (default 1)" },
      maxLines: { type: "number", description: "Lines to return (default 120)" },
    },
    ["path"],
  ),
  async run(args: { path: string; startLine?: number; maxLines?: number }) {
    if (!websiteRepoEnabled()) return NOT_CONNECTED;
    const content = await readRepoFile(args.path);
    const lines = content.split("\n");
    const start = Math.max(1, args.startLine ?? 1);
    const max = Math.min(args.maxLines ?? 120, 300);
    const window = lines.slice(start - 1, start - 1 + max).join("\n").slice(0, 5000);
    return {
      path: args.path,
      totalLines: lines.length,
      showing: `lines ${start}-${Math.min(start + max - 1, lines.length)}`,
      truncated: lines.length > start - 1 + max,
      content: window,
    };
  },
};

export const proposeSiteChange: Tool = {
  name: "propose_site_change",
  description:
    "Open a GitHub PULL REQUEST changing one file on the website — nothing goes live until the operator merges it. " +
    "Prefer find/replace mode (safe): pass `find` (must match EXACTLY ONCE in the current file) and `replace`. " +
    "Only pass full `newContent` for small files you've read in full. Use for landing-copy experiments, CTA tweaks, adding testimonials, etc.",
  risk: "low",
  parameters: schema(
    {
      path: { type: "string", description: "File path in the repo" },
      title: { type: "string", description: "PR title, e.g. 'Test: benefit-led hero headline'" },
      description: { type: "string", description: "Why this change — the hypothesis and expected effect" },
      find: { type: "string", description: "Exact text to replace (find/replace mode)" },
      replace: { type: "string", description: "Replacement text (find/replace mode)" },
      newContent: { type: "string", description: "Full new file content (only for small, fully-read files)" },
    },
    ["path", "title", "description"],
  ),
  async run(args: {
    path: string;
    title: string;
    description: string;
    find?: string;
    replace?: string;
    newContent?: string;
  }) {
    if (!websiteRepoEnabled()) return NOT_CONNECTED;

    let content: string;
    if (args.find !== undefined) {
      if (args.replace === undefined) return { error: "find given without replace" };
      const current = await readRepoFile(args.path);
      const first = current.indexOf(args.find);
      if (first === -1) return { error: "`find` text not found in the current file — re-read it and try again" };
      if (current.indexOf(args.find, first + 1) !== -1) {
        return { error: "`find` text matches more than once — include more surrounding context to make it unique" };
      }
      content = current.replace(args.find, args.replace);
    } else if (args.newContent !== undefined) {
      content = args.newContent;
    } else {
      return { error: "provide find+replace, or newContent" };
    }

    const { prUrl, branch } = await proposeChange({
      path: args.path,
      newContent: content,
      title: args.title,
      description: args.description,
    });
    await notify({
      kind: "site_pr",
      level: "important",
      title: `🌐 Website PR proposed: ${args.title}`,
      body: `${args.description}\n\nReview + merge: ${prUrl}`,
    });
    return { prUrl, branch, note: "PR opened — it does NOT go live until the operator merges it." };
  },
};
