import { schema, type Tool } from "./types.js";
import { codeRepoEnabled, listCodeRepoDir, proposeCodeChanges, readCodeRepoFile } from "../../services/github.service.js";
import { notify } from "../../services/notifications.service.js";

const NOT_CONNECTED = {
  error: "code repo not connected — set GITHUB_TOKEN + AGENT_CODE_REPO before using self-improvement tools",
};

export const listCodeFiles: Tool = {
  name: "list_code_files",
  description:
    "List files/directories in the agent's code repo. Use before proposing backend/tool changes so you understand the codebase shape.",
  risk: "low",
  parameters: schema({ path: { type: "string", description: "Directory path (default repo root)" } }),
  async run(args: { path?: string }) {
    if (!codeRepoEnabled()) return NOT_CONNECTED;
    return { entries: await listCodeRepoDir(args.path ?? "") };
  },
};

export const readCodeFile: Tool = {
  name: "read_code_file",
  description:
    "Read a file from the agent's code repo. Large files are windowed; use startLine/maxLines to inspect relevant sections before proposing changes.",
  risk: "low",
  parameters: schema(
    {
      path: { type: "string" },
      startLine: { type: "number", description: "1-based first line (default 1)" },
      maxLines: { type: "number", description: "Lines to return (default 160, max 300)" },
    },
    ["path"],
  ),
  async run(args: { path: string; startLine?: number; maxLines?: number }) {
    if (!codeRepoEnabled()) return NOT_CONNECTED;
    const content = await readCodeRepoFile(args.path);
    const lines = content.split("\n");
    const start = Math.max(1, args.startLine ?? 1);
    const max = Math.min(args.maxLines ?? 160, 300);
    return {
      path: args.path,
      totalLines: lines.length,
      showing: `lines ${start}-${Math.min(start + max - 1, lines.length)}`,
      truncated: lines.length > start - 1 + max,
      content: lines.slice(start - 1, start - 1 + max).join("\n").slice(0, 8000),
    };
  },
};

export const proposeCodeChange: Tool = {
  name: "propose_code_change",
  description:
    "Open a GitHub pull request against the agent's code repo. Use for small, reviewable self-improvements such as adding a missing tool. " +
    "Prefer find/replace changes. Only use full newContent for new files or small files read in full. This never merges or deploys.",
  risk: "high",
  parameters: schema(
    {
      title: { type: "string", description: "PR title" },
      description: { type: "string", description: "Why this code change is needed and how the operator should verify it" },
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path in the code repo" },
            find: { type: "string", description: "Exact current text to replace. Must match exactly once." },
            replace: { type: "string", description: "Replacement text when using find/replace mode" },
            newContent: { type: "string", description: "Full file content. Use mainly for new files." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    ["title", "description", "changes"],
  ),
  async run(args: {
    title: string;
    description: string;
    changes: { path: string; find?: string; replace?: string; newContent?: string }[];
  }) {
    if (!codeRepoEnabled()) return NOT_CONNECTED;
    if (!args.changes.length || args.changes.length > 8) return { error: "changes must contain 1-8 files" };

    const resolved: { path: string; newContent: string }[] = [];
    for (const change of args.changes) {
      if (!change.path || change.path.startsWith("/") || change.path.includes("..")) {
        return { error: `invalid path: ${change.path}` };
      }

      if (change.find !== undefined) {
        if (change.replace === undefined) return { error: `${change.path}: find given without replace` };
        const current = await readCodeRepoFile(change.path);
        const first = current.indexOf(change.find);
        if (first === -1) return { error: `${change.path}: find text not found; re-read the file and try again` };
        if (current.indexOf(change.find, first + 1) !== -1) {
          return { error: `${change.path}: find text matches more than once; include more surrounding context` };
        }
        resolved.push({ path: change.path, newContent: current.replace(change.find, change.replace) });
      } else if (change.newContent !== undefined) {
        if (change.newContent.length > 80_000) return { error: `${change.path}: newContent is too large` };
        resolved.push({ path: change.path, newContent: change.newContent });
      } else {
        return { error: `${change.path}: provide find+replace or newContent` };
      }
    }

    const { prUrl, branch } = await proposeCodeChanges({
      changes: resolved,
      title: args.title,
      description: args.description,
    });
    await notify({
      kind: "code_pr",
      level: "important",
      title: `Code PR proposed: ${args.title}`,
      body: `${args.description}\n\nReview + merge if correct: ${prUrl}`,
    });
    return {
      prUrl,
      branch,
      note: "Code PR opened. It does not merge or deploy until the operator reviews it.",
    };
  },
};
