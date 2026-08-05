import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("github");

const API = "https://api.github.com";

export function websiteRepoEnabled(): boolean {
  return Boolean(config.website.githubToken && config.website.repo);
}

export function codeRepoEnabled(): boolean {
  return Boolean(config.website.githubToken && config.codeRepo.repo);
}

type RepoKind = "website" | "code";

function repoFor(kind: RepoKind): string {
  const repo = kind === "website" ? config.website.repo : config.codeRepo.repo;
  if (!config.website.githubToken || !repo) {
    throw new Error(kind === "website" ? "GITHUB_TOKEN / WEBSITE_REPO not set" : "GITHUB_TOKEN / AGENT_CODE_REPO not set");
  }
  return repo;
}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.website.githubToken) throw new Error("GITHUB_TOKEN not set");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.website.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

let cachedWebsiteBaseBranch: string | null = null;
let cachedCodeBaseBranch: string | null = null;

/** The branch PRs target: WEBSITE_BRANCH, or the repo's default branch. */
async function baseBranch(kind: RepoKind): Promise<string> {
  const configured = kind === "website" ? config.website.branch : config.codeRepo.branch;
  if (configured) return configured;
  if (kind === "website" && cachedWebsiteBaseBranch) return cachedWebsiteBaseBranch;
  if (kind === "code" && cachedCodeBaseBranch) return cachedCodeBaseBranch;
  const repo = await gh<{ default_branch: string }>(`/repos/${repoFor(kind)}`);
  if (kind === "website") cachedWebsiteBaseBranch = repo.default_branch;
  else cachedCodeBaseBranch = repo.default_branch;
  return repo.default_branch;
}

export interface RepoEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}

export async function listRepoDir(path = ""): Promise<RepoEntry[]> {
  return listDir("website", path);
}

export async function listCodeRepoDir(path = ""): Promise<RepoEntry[]> {
  return listDir("code", path);
}

async function listDir(kind: RepoKind, path = ""): Promise<RepoEntry[]> {
  const ref = await baseBranch(kind);
  const repo = repoFor(kind);
  const entries = await gh<Array<{ path: string; type: string; size: number }>>(
    `/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (!Array.isArray(entries)) throw new Error(`${path} is a file, not a directory`);
  return entries.map((e) => ({ path: e.path, type: e.type === "dir" ? "dir" : "file", size: e.size }));
}

export async function readRepoFile(path: string): Promise<string> {
  return readFile("website", path);
}

export async function readCodeRepoFile(path: string): Promise<string> {
  return readFile("code", path);
}

async function readFile(kind: RepoKind, path: string): Promise<string> {
  const ref = await baseBranch(kind);
  const repo = repoFor(kind);
  const file = await gh<{ content?: string; encoding?: string; type?: string }>(
    `/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (file.type !== "file" || !file.content) throw new Error(`${path} is not a readable file`);
  return Buffer.from(file.content, "base64").toString("utf-8");
}

export interface RepoFileChange {
  path: string;
  newContent: string;
}

/**
 * Open a pull request changing ONE file on a fresh branch. Never touches the
 * base branch — a human reviews and merges (or closes) the PR on GitHub.
 */
export async function proposeChange(args: {
  path: string;
  newContent: string;
  title: string;
  description: string;
}): Promise<{ prUrl: string; branch: string }> {
  return proposeChanges("website", {
    changes: [{ path: args.path, newContent: args.newContent }],
    title: args.title,
    description: args.description,
    branchSlug: args.path,
    footer: "_Proposed by the SDR agent — review and merge if it looks right._",
  });
}

export async function proposeCodeChanges(args: {
  changes: RepoFileChange[];
  title: string;
  description: string;
}): Promise<{ prUrl: string; branch: string }> {
  return proposeChanges("code", {
    changes: args.changes,
    title: args.title,
    description: args.description,
    branchSlug: "code-tools",
    draft: true,
    footer:
      "_Proposed by the SDR agent as a draft self-improvement PR. Mark it ready only after the Build and test check passes._",
  });
}

async function proposeChanges(
  kind: RepoKind,
  args: {
    changes: RepoFileChange[];
    title: string;
    description: string;
    branchSlug: string;
    draft?: boolean;
    footer: string;
  },
): Promise<{ prUrl: string; branch: string }> {
  const repo = repoFor(kind);
  const base = await baseBranch(kind);
  if (!args.changes.length) throw new Error("at least one file change is required");
  const branch = `agent/${args.branchSlug.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}`;

  const baseRef = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  await gh(`/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
  });

  for (const change of args.changes) {
    // Existing file's blob sha is required to update it (absent for new files).
    let sha: string | undefined;
    try {
      const existing = await gh<{ sha: string }>(
        `/repos/${repo}/contents/${encodeURI(change.path)}?ref=${encodeURIComponent(branch)}`,
      );
      sha = existing.sha;
    } catch {
      sha = undefined;
    }

    await gh(`/repos/${repo}/contents/${encodeURI(change.path)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `${args.title}: ${change.path}`,
        content: Buffer.from(change.newContent, "utf-8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
  }

  const pr = await gh<{ html_url: string }>(`/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: args.title,
      head: branch,
      base,
      draft: args.draft ?? false,
      body:
        `${args.description}\n\nChanged files:\n${args.changes.map((c) => `- \`${c.path}\``).join("\n")}` +
        `\n\n${args.footer}`,
    }),
  });

  log.info(`opened PR ${pr.html_url}`);
  return { prUrl: pr.html_url, branch };
}
