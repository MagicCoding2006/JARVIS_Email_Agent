import { config } from "../config/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("github");

const API = "https://api.github.com";

export function websiteRepoEnabled(): boolean {
  return Boolean(config.website.githubToken && config.website.repo);
}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!websiteRepoEnabled()) throw new Error("GITHUB_TOKEN / WEBSITE_REPO not set");
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

let cachedBaseBranch: string | null = null;

/** The branch PRs target: WEBSITE_BRANCH, or the repo's default branch. */
async function baseBranch(): Promise<string> {
  if (config.website.branch) return config.website.branch;
  if (cachedBaseBranch) return cachedBaseBranch;
  const repo = await gh<{ default_branch: string }>(`/repos/${config.website.repo}`);
  cachedBaseBranch = repo.default_branch;
  return cachedBaseBranch;
}

export interface RepoEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}

export async function listRepoDir(path = ""): Promise<RepoEntry[]> {
  const ref = await baseBranch();
  const entries = await gh<Array<{ path: string; type: string; size: number }>>(
    `/repos/${config.website.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (!Array.isArray(entries)) throw new Error(`${path} is a file, not a directory`);
  return entries.map((e) => ({ path: e.path, type: e.type === "dir" ? "dir" : "file", size: e.size }));
}

export async function readRepoFile(path: string): Promise<string> {
  const ref = await baseBranch();
  const file = await gh<{ content?: string; encoding?: string; type?: string }>(
    `/repos/${config.website.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (file.type !== "file" || !file.content) throw new Error(`${path} is not a readable file`);
  return Buffer.from(file.content, "base64").toString("utf-8");
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
  const repo = config.website.repo;
  const base = await baseBranch();
  const branch = `agent/${args.path.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}-${Date.now().toString(36)}`;

  const baseRef = await gh<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  await gh(`/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
  });

  // Existing file's blob sha is required to update it (absent for new files).
  let sha: string | undefined;
  try {
    const existing = await gh<{ sha: string }>(
      `/repos/${repo}/contents/${encodeURI(args.path)}?ref=${encodeURIComponent(branch)}`,
    );
    sha = existing.sha;
  } catch {
    sha = undefined;
  }

  await gh(`/repos/${repo}/contents/${encodeURI(args.path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: args.title,
      content: Buffer.from(args.newContent, "utf-8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  const pr = await gh<{ html_url: string }>(`/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: args.title,
      head: branch,
      base,
      body: `${args.description}\n\n_Proposed by the SDR agent — review and merge if it looks right._`,
    }),
  });

  log.info(`opened PR ${pr.html_url}`);
  return { prUrl: pr.html_url, branch };
}
