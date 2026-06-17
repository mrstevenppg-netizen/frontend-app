const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const REPO_NAME = process.env.REPO_NAME || "this repo";
const GH_PAT = process.env.GH_PAT || "";
const COMMIT_PAYLOAD = (process.env.COMMIT_PAYLOAD || "").trim();
const FALLBACK_LOG_FILE = process.env.TARGET_LOG_FILE || "DEV_LOG.md";
const FALLBACK_COUNT = Number.parseInt(process.env.COMMIT_COUNT || "0", 10);

function parsePayload() {
  if (!COMMIT_PAYLOAD || COMMIT_PAYLOAD === "{}") {
    return {
      schemaVersion: 1,
      repo: REPO_NAME,
      timezone: "UTC",
      targetLogFile: FALLBACK_LOG_FILE,
      lateStart: {
        lateGraceMinutes: 25,
        tooLatePolicy: "skip",
        lateSpacingSeconds: { min: 75, max: 210 },
        stateFile: "",
        initCommitMessage: "docs: initialise development log"
      },
      commits: []
    };
  }

  try {
    const payload = JSON.parse(COMMIT_PAYLOAD);
    if (!Array.isArray(payload.commits)) throw new Error("payload.commits must be an array");
    return payload;
  } catch (err) {
    console.error(`Invalid COMMIT_PAYLOAD: ${err.message}`);
    process.exit(1);
  }
}

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8"
  });
}

function tryGit(args, options = {}) {
  try {
    return { ok: true, output: runGit(args, options) || "" };
  } catch (err) {
    return {
      ok: false,
      output: `${err.stdout || ""}${err.stderr || ""}`.trim(),
      error: err
    };
  }
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function deterministicNumber(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(31, hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function spacingMs(plannedId, lateStart) {
  const range = lateStart?.lateSpacingSeconds || { min: 75, max: 210 };
  const min = Number(range.min || 75);
  const max = Number(range.max || min);
  const seconds = min + (deterministicNumber(plannedId) % Math.max(1, max - min + 1));
  return seconds * 1000;
}

function deterministicPick(items, seed, fallback) {
  const list = items.filter(Boolean);
  if (list.length === 0) return fallback;
  return list[deterministicNumber(seed) % list.length];
}

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function readStateIds(stateFile) {
  if (!stateFile || !fs.existsSync(stateFile)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return new Set(Array.isArray(parsed.completedIds) ? parsed.completedIds : []);
  } catch {
    return new Set();
  }
}

function writeStateIds(stateFile, ids) {
  if (!stateFile) return;
  const dir = path.dirname(stateFile);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ completedIds: [...ids].sort() }, null, 2) + "\n");
}

function ensureLogHeader(logFile, payload) {
  if (fs.existsSync(logFile)) return false;
  const dir = path.dirname(logFile);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  const repoDisplay = (payload.repo || REPO_NAME).split("/").pop();
  const title = `# Dev Log - ${repoDisplay}\n\n`;
  const intro = "Ongoing development notes, maintenance observations, and project activity records.\n\n";
  fs.writeFileSync(logFile, title + intro);
  return true;
}

function nowUtcText() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function listDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dirPath, entry.name));
}

function inspectRepoContext(payload) {
  const fallbacks = payload.textStyle?.repoContextFallbacks || {};
  const context = {
    area: fallbacks.area || "project notes",
    artifact: fallbacks.artifact || "maintenance notes",
    workflow: fallbacks.workflow || "repo workflow",
    moduleKind: fallbacks.moduleKind || "project area"
  };

  if (fs.existsSync("package.json")) {
    context.artifact = "package metadata";
    context.moduleKind = "JavaScript project structure";
  }
  if (fs.existsSync("README.md")) context.artifact = "README notes";
  if (fs.existsSync(".github/workflows")) context.workflow = "GitHub Actions workflow";
  if (fs.existsSync("contracts")) {
    context.area = "contract notes";
    context.moduleKind = "contract area";
  } else if (fs.existsSync("src/components")) {
    context.area = "component notes";
    context.moduleKind = "UI component area";
  } else if (fs.existsSync("src")) {
    const srcDirs = listDirs("src").map((dir) => path.basename(dir));
    context.area = deterministicPick(srcDirs, `${payload.repo}-area`, "source notes");
    context.moduleKind = "source module";
  } else if (fs.existsSync("docs")) {
    context.area = "documentation notes";
    context.moduleKind = "documentation area";
  }

  const testDirs = ["test", "tests", "__tests__", "spec"].filter((dir) => fs.existsSync(dir));
  if (testDirs.length > 0) context.workflow = `${testDirs[0]} verification notes`;

  return context;
}

function renderTemplate(template, context) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => context[key] || key);
}

function naturalNote(commit, payload, context) {
  const rendered = renderTemplate(commit.logBody || "Recorded a small maintenance note for this repository.", context);
  const closers = payload.textStyle?.naturalClosers || [];
  const probability = Number(payload.textStyle?.includeSecondSentenceProbability ?? 0);
  const includeCloser = (deterministicNumber(`${commit.plannedId}-closer`) % 1000) / 1000 < probability;
  if (!includeCloser) return rendered;
  const closer = deterministicPick(closers, `${commit.plannedId}-closer-text`, "");
  return closer ? `${rendered} ${closer}` : rendered;
}

function plannedIdMarker(commit, lateStart) {
  if (lateStart.idMarkerStyle === "plain") return `Planned ID: ${commit.plannedId}`;
  return `<!-- activity-id: ${commit.plannedId} -->`;
}

function appendCommitLog(logFile, commit, payload) {
  const lateStart = payload.lateStart || {};
  const context = inspectRepoContext(payload);
  const note = naturalNote(commit, payload, context);
  const showMetadata = lateStart.showMetadata === true;
  const lines = [
    "",
    `## ${commit.logHeader || "Development Notes"} - ${commit.localDate || payload.date || new Date().toISOString().slice(0, 10)}`,
    "",
    plannedIdMarker(commit, lateStart),
    "",
    `- ${note}`,
    ""
  ];

  if (showMetadata) {
    lines.splice(4, 0,
      `- Time: ${nowUtcText()}`,
      `- Planned local time: ${commit.localTime || "unknown"} ${payload.timezone || ""}`.trim(),
      `- Category: ${commit.category || "maintenance"}`
    );
  }

  fs.appendFileSync(logFile, lines.join("\n"));
}

function appendMissedLog(logFile, commit, payload, reason) {
  const lines = [
    "",
    `## Missed Planned Activity - ${commit.localDate || payload.date || new Date().toISOString().slice(0, 10)}`,
    "",
    `- Time: ${nowUtcText()}`,
    `- Planned local time: ${commit.localTime || "unknown"} ${payload.timezone || ""}`.trim(),
    `- Planned ID: ${commit.plannedId}`,
    `- Reason: ${reason}`,
    ""
  ];
  fs.appendFileSync(logFile, lines.join("\n"));
}

function hasPlannedId(logText, stateIds, plannedId) {
  return logText.includes(plannedId) || stateIds.has(plannedId);
}

function commitChanges(message, logFile, stateFile) {
  runGit(["add", logFile]);
  if (stateFile) runGit(["add", stateFile]);
  runGit(["commit", "-m", message]);
}

function currentBranch() {
  const result = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
  const branch = result.ok ? result.output.trim() : "";
  return branch && branch !== "HEAD" ? branch : "main";
}

function defaultBranch() {
  const result = tryGit(["remote", "show", "origin"], { capture: true });
  const match = /HEAD branch:\s*(.+)/.exec(result.output || "");
  return match ? match[1].trim() : currentBranch();
}

function safeBranchName(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 120);
}

function branchName(payload, commits) {
  const workflow = payload.workflow || {};
  const prefix = workflow.branchPrefix || "activity";
  const firstId = commits[0]?.plannedId || "planned";
  return safeBranchName(`${prefix}/${payload.date || "today"}-${firstId.slice(-8)}`);
}

function remoteBranchExists(branch) {
  const result = tryGit(["ls-remote", "--heads", "origin", branch], { capture: true });
  return result.ok && result.output.trim().length > 0;
}

function checkoutWorkBranch(branch) {
  if (remoteBranchExists(branch)) {
    console.log(`Reusing existing remote branch: ${branch}`);
    const fetch = tryGit(["fetch", "origin", branch]);
    if (!fetch.ok) return false;
    return tryGit(["checkout", "-B", branch, `origin/${branch}`]).ok;
  }

  console.log(`Creating planned work branch: ${branch}`);
  return tryGit(["checkout", "-B", branch]).ok;
}

function pullRebase(branch, runtime) {
  if (runtime.pullBeforeWrite !== true && runtime.pullBeforePush !== true) return true;
  console.log(`Pulling latest changes for ${branch} with rebase.`);
  const result = tryGit(["pull", "--rebase", "origin", branch]);
  if (result.ok) return true;

  console.error("git pull --rebase failed.");
  if ((runtime.rebaseConflictPolicy || "abort") === "abort") {
    tryGit(["rebase", "--abort"]);
    console.error("Rebase aborted. This run will stop safely so it can be retried later.");
  }
  return false;
}

function pushWithRetry(branch, runtime) {
  const attempts = Math.max(1, Number(runtime.pushRetries || 3));
  const delay = Math.max(0, Number(runtime.pushRetryDelaySeconds || 12)) * 1000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`Pushing ${branch} (attempt ${attempt}/${attempts}).`);
    const result = tryGit(["push", "-u", "origin", branch]);
    if (result.ok) {
      if (attempt > 1) console.log("Push retry succeeded.");
      return true;
    }

    console.error(`Push failed on attempt ${attempt}.`);
    if (attempt < attempts) {
      if (!pullRebase(branch, runtime)) return false;
      sleep(delay);
    }
  }

  console.error("Push failed after all retry attempts.");
  return false;
}

function githubRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = https.request(
      {
        hostname: "api.github.com",
        path: apiPath,
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${GH_PAT}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "User-Agent": "daily-activity-bot"
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(raw ? JSON.parse(raw) : {});
          } else {
            reject(new Error(`GitHub API ${res.statusCode}: ${raw}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function openPullRequest(payload, branch, baseBranch, commits) {
  if (!GH_PAT) throw new Error("GH_PAT is required to open pull requests.");
  const workflow = payload.workflow || {};
  const title = `${workflow.titlePrefix || "docs: maintenance notes"} (${payload.date || commits[0]?.localDate || "planned"})`;
  const body = [
    workflow.body || "Small planned maintenance update.",
    "",
    "Planned activity IDs:",
    ...commits.map((commit) => `- ${commit.plannedId}`)
  ].join("\n");
  const draft = workflow.mode === "draft_pull_request";
  const [owner, repo] = (payload.repo || REPO_NAME).split("/");
  const created = await githubRequest("POST", `/repos/${owner}/${repo}/pulls`, {
    title,
    head: branch,
    base: baseBranch,
    body,
    draft
  });
  console.log(`Opened pull request: ${created.html_url || `#${created.number}`}`);
}

async function main() {
  const payload = parsePayload();
  const commits = payload.commits
    .filter((commit) => commit && commit.plannedId)
    .sort((a, b) => new Date(a.utcTime) - new Date(b.utcTime));
  const lateStart = payload.lateStart || {};
  const workflow = payload.workflow || { mode: "direct" };
  const stateFile = lateStart.stateFile || "";
  const lateGraceMs = Number(lateStart.lateGraceMinutes || 25) * 60 * 1000;
  const tooLatePolicy = lateStart.tooLatePolicy || "skip";
  const stateIds = readStateIds(stateFile);

  if (commits.length === 0) {
    console.log(`No planned commits received. Requested count was ${FALLBACK_COUNT}.`);
    process.exit(0);
  }

  console.log("");
  console.log(`Applying ${commits.length} planned commit(s).`);
  console.log(`Repo: ${payload.repo || REPO_NAME}`);
  console.log(`Timezone: ${payload.timezone || "unknown"}`);
  console.log(`Workflow mode: ${workflow.mode || "direct"}`);
  console.log("");

  let changed = false;
  let lastLateCommitAt = 0;
  const originalBranch = currentBranch();
  const baseBranch = defaultBranch();
  const usePullRequest = workflow.mode === "pull_request" || workflow.mode === "draft_pull_request";
  const workingBranch = usePullRequest ? branchName(payload, commits) : originalBranch;

  if (usePullRequest) {
    if (!checkoutWorkBranch(workingBranch)) {
      console.error("Could not create work branch. Stopping safely.");
      process.exit(1);
    }
  }

  if (!pullRebase(usePullRequest ? baseBranch : workingBranch, lateStart)) {
    process.exit(1);
  }

  for (const commit of commits) {
    const logFile = commit.logFile || payload.targetLogFile || FALLBACK_LOG_FILE;
    const logText = readTextIfExists(logFile);
    if (hasPlannedId(logText, stateIds, commit.plannedId)) {
      console.log(`Skipping duplicate planned commit ${commit.plannedId}`);
      continue;
    }

    const targetTime = new Date(commit.utcTime);
    const waitMs = targetTime.getTime() - Date.now();
    if (waitMs > 0) {
      const mins = Math.floor(waitMs / 60000);
      const secs = Math.floor((waitMs % 60000) / 1000);
      console.log(`Waiting ${mins}m ${secs}s for ${commit.plannedId} (${commit.localTime})`);
      sleep(waitMs);
    } else {
      const lateBy = Math.abs(waitMs);
      if (lateBy > lateGraceMs && tooLatePolicy === "skip") {
        console.log(`Skipping ${commit.plannedId}; planned time is too old.`);
        continue;
      }

      if (lastLateCommitAt > 0) {
        const delay = spacingMs(commit.plannedId, lateStart);
        console.log(`Spacing late commit ${commit.plannedId} by ${Math.round(delay / 1000)}s`);
        sleep(delay);
      }
      lastLateCommitAt = Date.now();

      if (lateBy > lateGraceMs && tooLatePolicy === "mark-missed") {
        ensureLogHeader(logFile, payload);
        appendMissedLog(logFile, commit, payload, "Workflow started after the configured late grace period.");
        stateIds.add(commit.plannedId);
        writeStateIds(stateFile, stateIds);
        commitChanges("docs: record missed planned activity", logFile, stateFile);
        changed = true;
        console.log(`Marked missed planned commit ${commit.plannedId}`);
        continue;
      }

      console.log(`Planned time already passed for ${commit.plannedId}; committing now.`);
    }

    ensureLogHeader(logFile, payload);
    appendCommitLog(logFile, commit, payload);
    stateIds.add(commit.plannedId);
    writeStateIds(stateFile, stateIds);
    commitChanges(commit.message || "docs: update development notes", logFile, stateFile);
    changed = true;
    console.log(`Committed ${commit.plannedId}: ${commit.message}`);
  }

  if (changed) {
    if (!pushWithRetry(workingBranch, lateStart)) process.exit(1);
    if (usePullRequest) {
      try {
        await openPullRequest(payload, workingBranch, baseBranch, commits);
      } catch (err) {
        console.error(`Failed to open pull request: ${err.message}`);
        if (workflow.fallbackToDirectPushOnPrFailure === true) {
          console.error("PR fallback is enabled, but branch was already pushed. Leaving branch for manual review.");
        }
        process.exit(1);
      }
    }
    console.log("");
    console.log(usePullRequest ? "Done. Planned commits pushed to branch and PR opened." : "Done. Planned commits pushed.");
  } else {
    console.log("");
    console.log("Nothing new to commit.");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
