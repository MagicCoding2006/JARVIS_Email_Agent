import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const railwayCli = ["--yes", "@railway/cli@5.30.4"];
const service = process.env.RAILWAY_OAUTH_SERVICE || "jarvis-sdr";
const environment = process.env.RAILWAY_OAUTH_ENVIRONMENT || "production";
const authPath = "/app/data/openai-oauth/auth.json";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
      env: process.env,
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

const tempDir = await mkdtemp(join(tmpdir(), "jarvis-railway-oauth-"));
const tempAuthFile = join(tempDir, "auth.json");

try {
  console.log("Opening ChatGPT sign-in for a dedicated Railway credential...");
  await run("npx", ["--no-install", "openai-oauth", "login", "--oauth-file", tempAuthFile]);

  const authJson = await readFile(tempAuthFile, "utf8");
  JSON.parse(authJson);
  const encoded = Buffer.from(authJson, "utf8").toString("base64");

  console.log(`Updating Railway service ${service} (${environment})...`);
  await run("npx", [
    ...railwayCli,
    "variable",
    "set",
    `OPENAI_OAUTH_FILE=${authPath}`,
    "--service",
    service,
    "--environment",
    environment,
    "--skip-deploys",
  ]);
  await run(
    "npx",
    [
      ...railwayCli,
      "variable",
      "set",
      "OPENAI_OAUTH_AUTH_JSON_BASE64",
      "--stdin",
      "--service",
      service,
      "--environment",
      environment,
    ],
    { input: encoded },
  );

  console.log("Railway OAuth credential updated. A deployment has been triggered.");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
