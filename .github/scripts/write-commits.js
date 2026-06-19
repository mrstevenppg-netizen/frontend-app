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
        lateGraceMinutes: 45,
        tooLatePolicy: "mark-missed",
        lateSpacingSeconds: { min: 75, max: 210 },
        stateFile: "",
        initCommitMessage: "docs: initialise development log",
      },
      commits: [],
    };
  }

  try {
    const payload = JSON.parse(COMMIT_PAYLOAD);
    if (!Array.isArray(payload.commits))
      throw new Error("payload.commits must be an array");
    return payload;
  } catch (err) {
    console.error(`Invalid COMMIT_PAYLOAD: ${err.message}`);
    process.exit(1);
  }
}

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
}

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
}

function tryGit(args, options = {}) {
  try {
    return { ok: true, output: runGit(args, options) || "" };
  } catch (err) {
    return {
      ok: false,
      output: `${err.stdout || ""}${err.stderr || ""}`.trim(),
      error: err,
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
  const seconds =
    min + (deterministicNumber(plannedId) % Math.max(1, max - min + 1));
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
    return new Set(
      Array.isArray(parsed.completedIds) ? parsed.completedIds : [],
    );
  } catch {
    return new Set();
  }
}

function writeStateIds(stateFile, ids) {
  if (!stateFile) return;
  const dir = path.dirname(stateFile);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ completedIds: [...ids].sort() }, null, 2) + "\n",
  );
}

function ensureLogHeader(logFile, payload) {
  if (fs.existsSync(logFile)) return false;
  const dir = path.dirname(logFile);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  const repoDisplay = (payload.repo || REPO_NAME).split("/").pop();
  const title = `# Dev Log - ${repoDisplay}\n\n`;
  const intro =
    "Ongoing development notes, maintenance observations, and project activity records.\n\n";
  fs.writeFileSync(logFile, title + intro);
  return true;
}

function nowUtcText() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function listDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dirPath, entry.name));
}

function inspectRepoContext(payload) {
  const fallbacks = payload.textStyle?.repoContextFallbacks || {};
  const context = {
    area: fallbacks.area || "project notes",
    artifact: fallbacks.artifact || "maintenance notes",
    workflow: fallbacks.workflow || "repo workflow",
    moduleKind: fallbacks.moduleKind || "project area",
  };

  if (fs.existsSync("package.json")) {
    context.artifact = "package metadata";
    context.moduleKind = "JavaScript project structure";
  }
  if (fs.existsSync("README.md")) context.artifact = "README notes";
  if (fs.existsSync(".github/workflows"))
    context.workflow = "GitHub Actions workflow";
  if (fs.existsSync("contracts")) {
    context.area = "contract notes";
    context.moduleKind = "contract area";
  } else if (fs.existsSync("src/components")) {
    context.area = "component notes";
    context.moduleKind = "UI component area";
  } else if (fs.existsSync("src")) {
    const srcDirs = listDirs("src").map((dir) => path.basename(dir));
    context.area = deterministicPick(
      srcDirs,
      `${payload.repo}-area`,
      "source notes",
    );
    context.moduleKind = "source module";
  } else if (fs.existsSync("docs")) {
    context.area = "documentation notes";
    context.moduleKind = "documentation area";
  }

  const testDirs = ["test", "tests", "__tests__", "spec"].filter((dir) =>
    fs.existsSync(dir),
  );
  if (testDirs.length > 0)
    context.workflow = `${testDirs[0]} verification notes`;

  return context;
}

function renderTemplate(template, context) {
  return String(template || "").replace(
    /\{([a-zA-Z0-9_]+)\}/g,
    (_, key) => context[key] || key,
  );
}

function naturalNote(commit, payload, context) {
  const rendered = renderTemplate(
    commit.logBody || "Recorded a small maintenance note for this repository.",
    context,
  );
  const closers = payload.textStyle?.naturalClosers || [];
  const probability = Number(
    payload.textStyle?.includeSecondSentenceProbability ?? 0,
  );
  const includeCloser =
    (deterministicNumber(`${commit.plannedId}-closer`) % 1000) / 1000 <
    probability;
  if (!includeCloser) return rendered;
  const closer = deterministicPick(
    closers,
    `${commit.plannedId}-closer-text`,
    "",
  );
  return closer ? `${rendered} ${closer}` : rendered;
}

function plannedIdMarker(commit, lateStart) {
  if (lateStart.idMarkerStyle === "plain")
    return `Planned ID: ${commit.plannedId}`;
  return `<!-- activity-id: ${commit.plannedId} -->`;
}

function appendCommitLog(logFile, commit, payload) {
  const lateStart = payload.lateStart || payload.targetRuntime || {};
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
    "",
  ];

  if (showMetadata) {
    lines.splice(
      4,
      0,
      `- Time: ${nowUtcText()}`,
      `- Planned local time: ${commit.localTime || "unknown"} ${payload.timezone || ""}`.trim(),
      `- Category: ${commit.category || "maintenance"}`,
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
    "",
  ];
  fs.appendFileSync(logFile, lines.join("\n"));
}

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

function noteTitleForPath(filePath, payload, commit) {
  const file = String(filePath || "").toLowerCase();
  if (file.includes("frontend")) return "Frontend Notes";
  if (file.includes("backend")) return "Backend Notes";
  if (file.includes("api")) return "API Review Notes";
  if (file.includes("ui")) return "UI Review Notes";
  if (file.includes("config")) return "Config Notes";
  if (file.includes("maintenance")) return "Repository Maintenance Notes";
  if (file.includes("review")) return "Review Notes";
  if (file.includes("project")) return "Project Notes";
  return titleCase(
    commit?.logHeader || payload?.repo?.split("/").pop() || "Development Notes",
  );
}

function ensureTextHeader(filePath, payload, commit, intro) {
  const title = noteTitleForPath(filePath, payload, commit);
  if (fs.existsSync(filePath)) return false;
  const dir = path.dirname(filePath);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    filePath,
    `# ${title}\n\n${intro || "Small honest maintenance notes for this repository."}\n\n`,
  );
  return true;
}

function appendTextNote(filePath, commit, payload, options = {}) {
  ensureTextHeader(filePath, payload, commit, options.intro);
  const lateStart = payload.lateStart || payload.targetRuntime || {};
  const context = inspectRepoContext(payload);
  const note = renderTemplate(
    options.note ||
      commit.logBody ||
      "Recorded a small maintenance note for this repository.",
    context,
  );
  const lines = [
    "",
    `## ${options.section || commit.logHeader || "Development Notes"} - ${commit.localDate || payload.date || new Date().toISOString().slice(0, 10)}`,
    "",
    plannedIdMarker(commit, lateStart),
    "",
    `- ${note}`,
    "",
  ];

  if (options.includeMetadata || lateStart.showMetadata === true) {
    lines.splice(
      4,
      0,
      `- Time: ${nowUtcText()}`,
      `- Planned local time: ${commit.localTime || "unknown"} ${payload.timezone || ""}`.trim(),
      `- Category: ${commit.category || "maintenance"}`,
    );
  }

  fs.appendFileSync(filePath, lines.join("\n"));
}

function hasPlannedId(logText, stateIds, plannedId) {
  return logText.includes(plannedId) || stateIds.has(plannedId);
}

function globToRegExp(glob) {
  const pattern = String(glob || "");
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      i++;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(char)) {
      regex += `\\${char}`;
      continue;
    }
    regex += char;
  }
  regex += "$";
  return new RegExp(regex);
}

function matchesAnyGlob(value, globs) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return (globs || []).some((glob) => globToRegExp(glob).test(normalized));
}

function walkFiles(rootDir = ".") {
  const results = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full) || entry.name;
      if (entry.isDirectory()) {
        if (
          [
            ".git",
            "node_modules",
            "dist",
            "build",
            "coverage",
            ".next",
            "out",
          ].includes(entry.name)
        ) {
          continue;
        }
        visit(full);
      } else {
        results.push(rel.replace(/\\/g, "/"));
      }
    }
  }

  if (fs.existsSync(rootDir)) visit(rootDir);
  return results;
}

function isBinaryText(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const slice = buffer.slice(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of slice) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious > slice.length * 0.3;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function readTextIfFile(filePath) {
  const buffer = readFileSafe(filePath);
  if (!buffer || isBinaryText(buffer)) return "";
  return buffer.toString("utf8");
}

function fileContainsConflictMarkers(text) {
  return /^(<<<<<<<|=======|>>>>>>>)/m.test(text);
}

function safeCandidateFile(filePath, payload, commit) {
  const safeTouch = payload.safeTouch || {};
  const excluded = safeTouch.excludedPaths || [];
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (normalized.endsWith(".env.example")) {
    // Explicitly allow safe comments in `.env.example` when the repo exposes it.
  } else if (matchesAnyGlob(normalized, excluded)) return false;
  if (normalized.endsWith(".min.js") || normalized.endsWith(".min.css"))
    return false;
  if (
    /package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb$/i.test(
      normalized,
    )
  )
    return false;
  if (
    /\.(png|jpe?g|gif|svg|ico|pdf|zip|gz|mp4|mp3|webp|woff2?)$/i.test(
      normalized,
    )
  )
    return false;
  const text = readTextIfFile(filePath);
  if (!text) return false;
  if (fileContainsConflictMarkers(text)) return false;
  if (text.includes(commit.plannedId)) return false;
  const maxSizeKb = Number(payload.changeModes?.maxSafeTouchFileSizeKb || 180);
  const sizeKb = fs.statSync(filePath).size / 1024;
  if (sizeKb > maxSizeKb) return false;
  return true;
}

function expandCandidatePattern(pattern) {
  const normalized = String(pattern || "").replace(/\\/g, "/");
  const exists = fs.existsSync(normalized);
  if (exists && fs.statSync(normalized).isFile()) return [normalized];
  const files = walkFiles(".");
  if (normalized.includes("*") || normalized.includes("?")) {
    return files.filter((file) => matchesAnyGlob(file, [normalized]));
  }
  return [];
}

function selectRepoTypeCandidates(payload, repoType, mode) {
  const safeTouch = payload.safeTouch || {};
  const repo = String(repoType || "general").toLowerCase();
  if (mode === "repo_context_note") {
    return [];
  }
  if (repo === "frontend") return safeTouch.frontendCandidates || [];
  if (repo === "backend") return safeTouch.backendCandidates || [];
  return [
    ...(safeTouch.frontendCandidates || []).slice(0, 4),
    ...(safeTouch.backendCandidates || []).slice(0, 4),
    "README.md",
  ];
}

function gatherCandidateFiles(payload, commit) {
  const repoType = String(
    commit.repoType || payload.repoType || "general",
  ).toLowerCase();
  const mode = commit.changeMode || "note_only";
  const candidates = [];
  if (mode === "note_only") {
    candidates.push(
      commit.logFile || payload.targetLogFile || FALLBACK_LOG_FILE,
    );
  } else if (mode === "repo_context_note") {
    const noteFiles = payload.repoContextNoteFiles?.[repoType] ||
      payload.repoContextNoteFiles?.general || ["docs/repo-maintenance.md"];
    candidates.push(...noteFiles);
  } else {
    candidates.push(...selectRepoTypeCandidates(payload, repoType, mode));
    if (commit.targetFileHint && commit.targetFileHint !== "auto") {
      candidates.unshift(commit.targetFileHint);
    }
  }
  const expanded = [];
  for (const candidate of candidates.filter(Boolean)) {
    expanded.push(...expandCandidatePattern(candidate));
  }
  return [
    ...new Set(expanded.map((filePath) => filePath.replace(/\\/g, "/"))),
  ].filter((filePath) => {
    return (
      fs.existsSync(filePath) &&
      fs.statSync(filePath).isFile() &&
      safeCandidateFile(filePath, payload, commit)
    );
  });
}

function fileCommentStyle(filePath) {
  const lower = String(filePath || "").toLowerCase();
  if (
    lower.endsWith(".css") ||
    lower.endsWith(".scss") ||
    lower.endsWith(".less")
  )
    return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".md")) return "markdown";
  if (
    lower.endsWith(".jsx") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".mjs")
  )
    return "js";
  if (lower.endsWith(".json")) return "json";
  return "plain";
}

function commentTextFor(commit, payload, style) {
  const type = String(
    commit.repoType || payload.repoType || "general",
  ).toLowerCase();
  const category = String(commit.category || "maintenance");
  const note =
    commit.changeMode === "minor_maintenance_patch"
      ? `Small cleanup reminder for ${category}.`
      : type === "frontend"
        ? `Keep this ${category} section easy to review during the next frontend pass.`
        : type === "backend"
          ? `Keep this ${category} section easy to review during the next backend pass.`
          : `Keep this ${category} section easy to review during the next maintenance pass.`;

  if (style === "css") return `/* ${note} */`;
  if (style === "html" || style === "markdown") return `<!-- ${note} -->`;
  if (style === "yaml") return `# ${note}`;
  if (style === "js") return `// ${note}`;
  return `# ${note}`;
}

function noteInsertionPoint(text, style) {
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (
    index < lines.length &&
    (lines[index].startsWith("#!") ||
      lines[index].startsWith("//") ||
      lines[index].startsWith("/*") ||
      lines[index].startsWith("<!--"))
  ) {
    index += 1;
  }
  if (style === "markdown") {
    for (let i = 0; i < lines.length; i++) {
      if (/^#\s+/.test(lines[i])) {
        return i + 1;
      }
    }
  }
  return index;
}

function insertTinyComment(text, comment, style) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const index = noteInsertionPoint(text, style);
  lines.splice(index, 0, comment);
  return lines.join(newline).replace(/\n?$/, newline);
}

function cleanMinorPatch(text) {
  let updated = text;
  const original = updated;
  updated = updated.replace(/\n{3,}/g, "\n\n");
  updated = updated.replace(/[ \t]+$/gm, "");
  updated = updated.replace(/([.!?])  /g, "$1 ");
  if (updated === original) {
    const typoPairs = [
      ["behaviour", "behavior"],
      ["colour", "color"],
      ["organisation", "organization"],
    ];
    for (const [from, to] of typoPairs) {
      if (updated.includes(from)) {
        updated = updated.replace(from, to);
        break;
      }
    }
  }
  return updated === original ? null : updated;
}

function runGitCapture(args) {
  return tryGit(args, { capture: true }).output || "";
}

function gitDiffContainsPlannedId(plannedId) {
  const diff = `${runGitCapture(["diff", "--cached", "--unified=0"])}\n${runGitCapture(["diff", "--unified=0"])}`;
  return diff.includes(plannedId);
}

function gitLogContainsPlannedId(plannedId) {
  const result = tryGit(["log", "--all", "--format=%B"], { capture: true });
  return result.ok && result.output.includes(plannedId);
}

function gitWorkingTreeContainsPlannedId(plannedId) {
  const files = walkFiles(".");
  for (const file of files) {
    const text = readTextIfFile(file);
    if (text.includes(plannedId)) return true;
  }
  return false;
}

function gitDiffLineCount() {
  const result = tryGit(["diff", "--numstat"], { capture: true });
  if (!result.ok || !result.output.trim()) return 0;
  return result.output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(/\t/))
    .reduce((sum, [added, removed]) => {
      const a = Number(added);
      const r = Number(removed);
      return sum + (Number.isFinite(a) ? a : 0) + (Number.isFinite(r) ? r : 0);
    }, 0);
}

function validateSafeTouch(filePath, payload) {
  if (!payload.safeTouch?.validateAfterTouch)
    return { ok: true, reason: "validation disabled" };
  if (payload.safeTouch?.runDiffCheck !== false) {
    const check = tryGit(["diff", "--check"], { capture: true });
    if (!check.ok) {
      return {
        ok: false,
        reason: `git diff --check failed: ${check.output || "unknown diff issue"}`,
      };
    }
  }
  const hasPackageJson = fs.existsSync("package.json");
  if (hasPackageJson && payload.safeTouch?.runNpmLintIfPresent !== false) {
    try {
      runCommand("npm", ["run", "lint", "--if-present"], { capture: true });
    } catch (err) {
      return {
        ok: false,
        reason: `npm run lint --if-present failed: ${
          `${err.stdout || ""}${err.stderr || ""}`.trim() ||
          err.message ||
          "unknown"
        }`,
      };
    }
  }
  if (hasPackageJson && payload.safeTouch?.runNpmTestIfPresent !== false) {
    try {
      runCommand("npm", ["test", "--if-present"], { capture: true });
    } catch (err) {
      return {
        ok: false,
        reason: `npm test --if-present failed: ${
          `${err.stdout || ""}${err.stderr || ""}`.trim() ||
          err.message ||
          "unknown"
        }`,
      };
    }
  }
  const maxLines = Number(payload.changeModes?.maxSafeTouchChangedLines || 8);
  if (gitDiffLineCount() > maxLines) {
    return { ok: false, reason: `changed line count exceeded ${maxLines}` };
  }
  return { ok: true, reason: "validation passed" };
}

function commitChanges(message, bodyLines, filesToAdd, stateFile) {
  const args = ["add", ...filesToAdd];
  runGit(args);
  if (stateFile) runGit(["add", stateFile]);
  const commitArgs = ["commit", "-m", message];
  if (Array.isArray(bodyLines) && bodyLines.length > 0) {
    for (const line of bodyLines) commitArgs.push("-m", line);
  }
  runGit(commitArgs);
}

function currentBranch() {
  const result = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    capture: true,
  });
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
  const planned =
    commits[0]?.plannedBranchName || workflow.plannedBranchName || "";
  if (planned) return safeBranchName(planned);
  const prefix = workflow.branchPrefix || "activity";
  const firstId = commits[0]?.plannedId || "planned";
  return safeBranchName(
    `${prefix}/${payload.date || "today"}-${firstId.slice(-8)}`,
  );
}

function remoteBranchExists(branch) {
  const result = tryGit(["ls-remote", "--heads", "origin", branch], {
    capture: true,
  });
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
  if (runtime.pullBeforeWrite !== true && runtime.pullBeforePush !== true)
    return true;
  console.log(`Pulling latest changes for ${branch} with rebase.`);
  const result = tryGit(["pull", "--rebase", "origin", branch]);
  if (result.ok) return true;

  console.error("git pull --rebase failed.");
  if ((runtime.rebaseConflictPolicy || "abort") === "abort") {
    tryGit(["rebase", "--abort"]);
    console.error(
      "Rebase aborted. This run will stop safely so it can be retried later.",
    );
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
          "User-Agent": "daily-activity-bot",
        },
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
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function githubJson(method, apiPath, body) {
  const data = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
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
          "User-Agent": "daily-activity-bot",
        },
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
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function findOpenPullRequest(plannedId, payload) {
  if (!GH_PAT) return null;
  const [owner, repo] = (payload.repo || REPO_NAME).split("/");
  try {
    const pulls = await githubJson(
      "GET",
      `/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
    );
    return (
      (pulls || []).find((pull) => {
        const haystack = `${pull.title || ""}\n${pull.body || ""}\n${pull.head?.ref || ""}`;
        return haystack.includes(plannedId);
      }) || null
    );
  } catch {
    return null;
  }
}

async function openPullRequest(payload, branch, baseBranch, commits) {
  if (!GH_PAT) throw new Error("GH_PAT is required to open pull requests.");
  const workflow = payload.workflow || {};
  const title =
    commits[0]?.plannedPrTitle ||
    workflow.titlePrefix ||
    "docs: maintenance notes";
  const bodyLines = renderPullRequestBody(payload, commits);
  const collisionPolicy = payload.prCollisionPolicy || {};
  if (collisionPolicy.reuseExistingOpenPr !== false) {
    const existing = await findOpenPullRequest(
      commits[0]?.plannedId || "",
      payload,
    );
    if (existing) {
      console.log(
        `Open PR already exists for ${commits[0]?.plannedId}: ${existing.html_url || `#${existing.number}`}`,
      );
      return;
    }
  }
  const draft = workflow.mode === "draft_pull_request";
  const [owner, repo] = (payload.repo || REPO_NAME).split("/");
  const created = await githubRequest("POST", `/repos/${owner}/${repo}/pulls`, {
    title,
    head: branch,
    base: baseBranch,
    body: bodyLines,
    draft,
  });
  console.log(
    `Opened pull request: ${created.html_url || `#${created.number}`}`,
  );
}

function renderPullRequestBody(payload, commits) {
  const summaryLines = [];
  const changes = new Set();
  const plannedIds = [];
  const targetFiles = new Set();
  const changeModes = new Set();
  const categories = new Set();
  const validationResults = commits
    .map((commit) => commit.validationResult || "")
    .filter(Boolean);
  const runtimeChange = commits.some(
    (commit) => commit.expectedRuntimeChange === true,
  );

  for (const commit of commits) {
    plannedIds.push(commit.plannedId);
    if (commit.targetFileUsed) targetFiles.add(commit.targetFileUsed);
    if (commit.changeMode) changeModes.add(commit.changeMode);
    if (commit.category) categories.add(commit.category);

    const summary = commit.plannedPrSummary || {};
    if (Array.isArray(summary.changes)) {
      for (const item of summary.changes) changes.add(item);
    } else if (summary.changes) {
      changes.add(String(summary.changes));
    } else if (commit.message) {
      changes.add(commit.message);
    }
  }

  summaryLines.push("Small planned maintenance pass.");
  summaryLines.push("");
  summaryLines.push("Changes:");
  if (changes.size === 0) {
    summaryLines.push("- Recorded a small honest maintenance note.");
  } else {
    for (const change of changes) summaryLines.push(`- ${change}`);
  }
  summaryLines.push("");
  summaryLines.push("Runtime behavior:");
  summaryLines.push(
    runtimeChange
      ? "- No runtime behavior changed."
      : "- No runtime behavior changed.",
  );
  summaryLines.push("");
  summaryLines.push("Validation:");
  if (validationResults.length > 0) {
    for (const result of validationResults) summaryLines.push(`- ${result}`);
  } else {
    summaryLines.push("- Validation results were not recorded.");
  }
  summaryLines.push("");
  summaryLines.push("Automation transparency:");
  summaryLines.push(
    "- This PR was created by the educational GitHub activity workflow.",
  );
  summaryLines.push("- It records small maintenance/logging/review work only.");
  summaryLines.push("");
  summaryLines.push("Planned metadata:");
  summaryLines.push(`- Planned IDs: ${plannedIds.join(", ")}`);
  summaryLines.push(`- Categories: ${[...categories].join(", ") || "n/a"}`);
  summaryLines.push(`- Change modes: ${[...changeModes].join(", ") || "n/a"}`);
  summaryLines.push(
    `- Target files: ${[...targetFiles].join(", ") || payload.targetLogFile || "n/a"}`,
  );
  return summaryLines.join("\n");
}

function bodyLinesForCommit(commit, payload, note) {
  return [
    `Planned ID: ${commit.plannedId}`,
    `Change mode: ${commit.changeMode}`,
    `Target file: ${commit.targetFileUsed || commit.targetFileHint || payload.targetLogFile || FALLBACK_LOG_FILE}`,
    `Category: ${commit.category || "maintenance"}`,
    `Validation: ${note || "not run"}`,
  ];
}

function resolveWorkingBranch(payload, commits) {
  const base = branchName(payload, commits);
  if (!remoteBranchExists(base)) return base;
  const suffix = commits[0]?.plannedId
    ? `-${commits[0].plannedId.slice(-8)}`
    : "";
  const collisionBranch = safeBranchName(`${base}${suffix}`);
  if (collisionBranch !== base) {
    console.log(`Branch collision detected; using ${collisionBranch}.`);
    return collisionBranch;
  }
  return base;
}

function duplicatePlannedIdReason(plannedId, logFile, stateIds, payload) {
  const logText = readTextIfExists(logFile);
  if (hasPlannedId(logText, stateIds, plannedId))
    return "log file or state file already contains the planned ID";
  if (gitLogContainsPlannedId(plannedId))
    return "git log already contains the planned ID";
  if (gitDiffContainsPlannedId(plannedId))
    return "working diff already contains the planned ID";
  if (gitWorkingTreeContainsPlannedId(plannedId))
    return "working tree already contains the planned ID";
  return null;
}

function applyNoteCommit(commit, payload, stateIds, stateFile) {
  const noteFile = commit.logFile || payload.targetLogFile || FALLBACK_LOG_FILE;
  appendTextNote(noteFile, commit, payload, {
    section: commit.logHeader || "Development Notes",
    intro:
      "Ongoing development notes, maintenance observations, and project activity records.",
  });
  commit.targetFileUsed = noteFile;
  const note = commit.validationResult || "validation not required";
  commitChanges(
    commit.message || "docs: update development notes",
    bodyLinesForCommit(commit, payload, note),
    [noteFile],
    stateFile,
  );
  stateIds.add(commit.plannedId);
  writeStateIds(stateFile, stateIds);
  return { ok: true, noteFile };
}

function applyRepoContextNote(commit, payload, stateIds, stateFile) {
  const noteFile =
    commit.targetFileHint && commit.targetFileHint !== "auto"
      ? commit.targetFileHint
      : commit.logFile || payload.targetLogFile || FALLBACK_LOG_FILE;
  appendTextNote(noteFile, commit, payload, {
    section: noteTitleForPath(noteFile, payload, commit),
    intro: "Short repo-specific context for the next maintenance pass.",
  });
  commit.targetFileUsed = noteFile;
  const note = commit.validationResult || "validation not required";
  commitChanges(
    commit.message || "docs: update project notes",
    bodyLinesForCommit(commit, payload, note),
    [noteFile],
    stateFile,
  );
  stateIds.add(commit.plannedId);
  writeStateIds(stateFile, stateIds);
  return { ok: true, noteFile };
}

function revertTouchedFile(filePath) {
  if (!filePath) return;
  tryGit(["restore", "--staged", "--worktree", "--", filePath]);
}

function applySafeTouch(commit, payload) {
  const candidates = gatherCandidateFiles(payload, commit);
  if (candidates.length === 0) {
    return { ok: false, reason: "no safe candidate files were found" };
  }

  const filePath = deterministicPick(
    candidates,
    `${commit.plannedId}|${commit.changeMode}`,
    candidates[0],
  );
  const original = readTextIfFile(filePath);
  if (!original) {
    return { ok: false, reason: "candidate file could not be read safely" };
  }

  const style = fileCommentStyle(filePath);
  const comment = commentTextFor(commit, payload, style);
  let updated = null;
  if (commit.changeMode === "minor_maintenance_patch") {
    updated = cleanMinorPatch(original);
  } else {
    updated = insertTinyComment(original, comment, style);
  }

  if (!updated || updated === original) {
    return {
      ok: false,
      reason: "no safe patch was available for the selected file",
    };
  }

  fs.writeFileSync(filePath, updated);
  commit.targetFileUsed = filePath;
  const validation = validateSafeTouch(filePath, payload);
  commit.validationResult = validation.reason;
  if (!validation.ok) {
    revertTouchedFile(filePath);
    return { ok: false, reason: validation.reason, filePath };
  }
  return { ok: true, filePath };
}

async function main() {
  const payload = parsePayload();
  const commits = payload.commits
    .filter((commit) => commit && commit.plannedId)
    .sort((a, b) => new Date(a.utcTime) - new Date(b.utcTime));
  const lateStart = payload.lateStart || payload.targetRuntime || {};
  const workflow = payload.workflow || { mode: "direct" };
  const isForceActivityTest = payload.forceActivity === true;
  const stateFile = lateStart.stateFile || "";
  const lateGraceMs = Number(lateStart.lateGraceMinutes || 45) * 60 * 1000;
  const tooLatePolicy = lateStart.tooLatePolicy || "mark-missed";
  const stateIds = readStateIds(stateFile);

  if (commits.length === 0) {
    console.log(
      `No planned commits received. Requested count was ${FALLBACK_COUNT}.`,
    );
    process.exit(0);
  }

  console.log("");
  console.log(`Applying ${commits.length} planned commit(s).`);
  console.log(`Repo: ${payload.repo || REPO_NAME}`);
  console.log(`Timezone: ${payload.timezone || "unknown"}`);
  console.log(`Workflow mode: ${workflow.mode || "direct"}`);
  if (isForceActivityTest) {
    console.log("Force activity test mode: future waits will be skipped.");
  }
  console.log("");

  let changed = false;
  let lastLateCommitAt = 0;
  const originalBranch = currentBranch();
  const baseBranch = defaultBranch();
  const usePullRequest =
    workflow.mode === "pull_request" || workflow.mode === "draft_pull_request";
  const workingBranch = usePullRequest
    ? resolveWorkingBranch(payload, commits)
    : originalBranch;

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
    const logFile =
      commit.logFile || payload.targetLogFile || FALLBACK_LOG_FILE;
    const duplicateReason = duplicatePlannedIdReason(
      commit.plannedId,
      logFile,
      stateIds,
      payload,
    );
    if (duplicateReason) {
      console.log(
        `Skipping duplicate planned commit ${commit.plannedId} (${duplicateReason})`,
      );
      continue;
    }

    if (
      usePullRequest &&
      (payload.prCollisionPolicy || {}).reuseExistingOpenPr !== false
    ) {
      const existingPr = await findOpenPullRequest(commit.plannedId, payload);
      if (existingPr) {
        console.log(
          `Skipping duplicate planned commit ${commit.plannedId}; open PR already exists (${existingPr.html_url || `#${existingPr.number}`}).`,
        );
        continue;
      }
    }

    const targetTime = new Date(commit.utcTime);
    const waitMs = targetTime.getTime() - Date.now();
    if (waitMs > 0) {
      if (isForceActivityTest) {
        console.log(
          `Skipping wait for ${commit.plannedId} (${commit.localTime}) because force_activity test mode is enabled.`,
        );
      } else {
        const mins = Math.floor(waitMs / 60000);
        const secs = Math.floor((waitMs % 60000) / 1000);
        console.log(
          `Waiting ${mins}m ${secs}s for ${commit.plannedId} (${commit.localTime})`,
        );
        sleep(waitMs);
      }
    } else {
      const lateBy = Math.abs(waitMs);
      if (lateBy > lateGraceMs && tooLatePolicy === "skip") {
        console.log(`Skipping ${commit.plannedId}; planned time is too old.`);
        continue;
      }

      if (lastLateCommitAt > 0) {
        const delay = spacingMs(commit.plannedId, lateStart);
        console.log(
          `Spacing late commit ${commit.plannedId} by ${Math.round(delay / 1000)}s`,
        );
        sleep(delay);
      }
      lastLateCommitAt = Date.now();

      if (lateBy > lateGraceMs && tooLatePolicy === "mark-missed") {
        ensureLogHeader(logFile, payload);
        appendMissedLog(
          logFile,
          commit,
          payload,
          "Workflow started after the configured late grace period.",
        );
        commitChanges(
          "docs: record missed planned activity",
          bodyLinesForCommit(commit, payload, "missed planned activity"),
          [logFile],
          stateFile,
        );
        stateIds.add(commit.plannedId);
        writeStateIds(stateFile, stateIds);
        changed = true;
        console.log(`Marked missed planned commit ${commit.plannedId}`);
        continue;
      }

      console.log(
        `Planned time already passed for ${commit.plannedId}; committing now.`,
      );
    }

    commit.validationResult = "not required";
    let result = null;
    if (commit.changeMode === "note_only") {
      result = applyNoteCommit(commit, payload, stateIds, stateFile);
    } else if (commit.changeMode === "repo_context_note") {
      result = applyRepoContextNote(commit, payload, stateIds, stateFile);
    } else if (
      commit.changeMode === "safe_file_touch" ||
      commit.changeMode === "minor_maintenance_patch"
    ) {
      const safe = applySafeTouch(commit, payload);
      if (safe.ok) {
        commitChanges(
          commit.message || "chore: annotate frontend structure",
          bodyLinesForCommit(
            commit,
            payload,
            commit.validationResult || "passed",
          ),
          [commit.targetFileUsed],
          stateFile,
        );
        stateIds.add(commit.plannedId);
        writeStateIds(stateFile, stateIds);
        result = { ok: true, filePath: commit.targetFileUsed };
      } else if (
        (payload.changeModes || {}).fallbackToNoteOnlyOnUnsafe !== false
      ) {
        console.log(
          `Safe touch for ${commit.plannedId} was rejected (${safe.reason}); falling back to note-only.`,
        );
        commit.targetFileUsed =
          commit.logFile || payload.targetLogFile || FALLBACK_LOG_FILE;
        commit.message = "docs: record maintenance note";
        commit.changeMode = "note_only";
        commit.validationResult = `fallback from ${commit.plannedId}: ${safe.reason}`;
        commit.plannedPrTitle = "docs: record maintenance note";
        commit.plannedPrSummary = {
          intro: "Small planned maintenance pass.",
          changes: [
            `Reverted a risky safe touch and recorded an honest note-only update for ${commit.category || "maintenance"}.`,
          ],
          runtimeBehavior: "No runtime behavior changed.",
          transparency:
            "This PR was created by the educational GitHub activity workflow and records small maintenance/logging/review work only.",
          category: commit.category || "maintenance",
          changeMode: "note_only",
          targetFile:
            commit.logFile || payload.targetLogFile || FALLBACK_LOG_FILE,
        };
        result = applyNoteCommit(commit, payload, stateIds, stateFile);
      } else {
        console.log(
          `Skipping unsafe planned touch ${commit.plannedId}: ${safe.reason}`,
        );
        continue;
      }
    } else {
      result = applyNoteCommit(commit, payload, stateIds, stateFile);
    }

    if (result?.ok) {
      changed = true;
      console.log(
        `Committed ${commit.plannedId}: ${commit.message} (${commit.changeMode})`,
      );
    }
  }

  if (changed) {
    if (!pushWithRetry(workingBranch, lateStart)) process.exit(1);
    if (usePullRequest) {
      try {
        await openPullRequest(payload, workingBranch, baseBranch, commits);
      } catch (err) {
        console.error(`Failed to open pull request: ${err.message}`);
        if (workflow.fallbackToDirectPushOnPrFailure === true) {
          console.error(
            "PR fallback is enabled, but branch was already pushed. Leaving branch for manual review.",
          );
        }
        process.exit(1);
      }
    }
    console.log("");
    console.log(
      usePullRequest
        ? "Done. Planned commits pushed to branch and PR opened."
        : "Done. Planned commits pushed.",
    );
  } else {
    console.log("");
    console.log("Nothing new to commit.");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
