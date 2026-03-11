/**
 * server.js (single file)
 *
 * Modes:
 *   node server.js                 -> NORMAL (reads .mocharc.json)
 *   node server.js --project       -> PROJECT (reads /result from result.json)
 *   node server.js --test          -> force "all passed" (works in both)
 *   node server.js --project --test -> project + force pass
 *
 * PROJECT MODE
 * - /result only returns the contents of result.json
 * - ./test/.next_command is watched
 * - when that file receives a real command, the current mocha child is triggered automatically
 * - result.json is set to { state: "running", ...responseObject }
 * - once finished, result.json becomes { state: "finished", ...responseObject }
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { execSync } = require("child_process");

// ----------------------------
// Shared config + flags
// ----------------------------
const PORT = process.env.PORT || 3000;
const TEST_DIR = path.join(__dirname, "test");
const MOCHA_RC = path.join(__dirname, ".mocharc.json");
const RESULT_FILE = path.join(__dirname, "result.json");
const NEXT_COMMAND_FILE = path.join(TEST_DIR, ".next_command");

const TEST_MODE = process.argv.includes("--test");
const PROJECT_MODE = process.argv.includes("--project");
const TEST_MAIL = process.argv.includes("--testmail");

// ----------------------------
// Challenges
// ----------------------------

function getFlagValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return null;
  return v;
}

const REQUESTED_ID = getFlagValue("--id");

const CHALLENGES = [
  { name: "Learn Bash by Building a Boilerplate", uuid: "a1B", order: 1 },
  { name: "Learn Relational Databases by Building a Mario Database", uuid: "c7D", order: 2 },
  { name: "Celestial Bodies Database", uuid: "e3F", order: 3 },
  { name: "Learn Bash Scripting by Building Five Programs", uuid: "g9H", order: 4 },
  { name: "Learn SQL by Building a Student Database: Part 1", uuid: "i2J", order: 5 },
  { name: "Learn SQL by Building a Student Database: Part 2", uuid: "k6L", order: 6 },
  { name: "World Cup Database", uuid: "m8N", order: 7 },
  { name: "Learn Advanced Bash by Building a Kitty Ipsum Translator", uuid: "p4Q", order: 8 },
  { name: "Learn Bash and SQL by Building a Bike Rental Shop", uuid: "r1S", order: 9 },
  { name: "Salon Appointment Scheduler", uuid: "t5U", order: 10 },
  { name: "Learn Nano by Building a Castle", uuid: "v7W", order: 11 },
  { name: "Learn Git by Building an SQL Reference Object", uuid: "x2Y", order: 12 },
  { name: "Periodic Table Database", uuid: "z9A", order: 13 },
  { name: "Number Guessing Game", uuid: "b3C", order: 14 },
];

const SELECTED_CHALLENGE = REQUESTED_ID
  ? CHALLENGES.find((c) => c.uuid === REQUESTED_ID) || null
  : null;

function whoIsAndWhere(payload) {
  let email = "";
  if (TEST_MAIL) {
    email = "fagroudfatimazahra0512@gmail.com";
  } else {
    try {
      email = execSync("git config --get user.email", { encoding: "utf8" }).trim();
    } catch (e) {
      email = "";
    }
  }

  return {
    email,
    order: SELECTED_CHALLENGE?.order ?? null,
    ...payload,
  };
}

// ----------------------------
// Shared utilities
// ----------------------------
function attachCommonMiddleware(app) {
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    next();
  });

  app.use((req, res, next) => {
    console.log("➡️", req.method, req.url);
    next();
  });
}

// supports: 1.test.js, 20.test.js, 1.1.test.js, 10.25.test.js
function getAllTests() {
  if (!fs.existsSync(TEST_DIR)) return [];

  const tests = fs
    .readdirSync(TEST_DIR)
    .filter((f) => /^\d+(\.\d+)?\.test\.js$/.test(f))
    .map((f) => ({ file: f, step: parseFloat(f) }))
    .sort((a, b) => a.step - b.step);

  if (PROJECT_MODE) return tests;

  tests.pop();

  return tests;
}

function addStats(payload) {
  const total = Number.isFinite(payload.total) ? payload.total : 0;
  const passedCount = Array.isArray(payload.passed) ? payload.passed.length : 0;
  const lockedCount = Array.isArray(payload.locked) ? payload.locked.length : 0;

  const denom = total > 0 ? total : 1;
  const passedPercent = Math.round((passedCount / denom) * 100);
  const lockedPercent = Math.round((lockedCount / denom) * 100);

  return {
    ...payload,
    totalCount: total,
    passedCount,
    lockedCount,
    passedPercent,
    lockedPercent,
    progress: total > 0 ? passedPercent : 0,
  };
}

function truncate(str, max = 6000) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + `\n... (truncated ${str.length - max} chars)` : str;
}

function firstUsefulLine(text) {
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[0] || "";
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeWriteJson(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function isRealCommand(text) {
  const value = String(text || "").trim();
  if (!value) return false;

  const ignored = new Set([
    "wait",
    "waiting",
    "idle",
    "noop",
    "none",
    "null",
    "undefined",
    "#",
  ]);

  return !ignored.has(value.toLowerCase());
}

/**
 * Encapsulated Mocha runner (child process)
 * - Uses `npx mocha <testFile>`
 * - Returns stdout/stderr/exit code to include in JSON
 */
function runMochaInChild(testFileAbsPath) {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const args = ["mocha", "--timeout", "25000", testFileAbsPath];

    const proc = spawn(cmd, args, {
      cwd: __dirname,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      resolve({
        passed: code === 0,
        exitCode: code,
        stdout,
        stderr,
      });
    });

    proc.on("error", (err) => {
      resolve({
        passed: false,
        exitCode: 1,
        stdout,
        stderr: (stderr ? stderr + "\n" : "") + String(err?.message || err),
      });
    });
  });
}

// ----------------------------
// NORMAL MODE implementation
// ----------------------------
function startNormalServer() {
  const app = express();
  attachCommonMiddleware(app);

  function getResultNormal() {
    if (!fs.existsSync(MOCHA_RC)) {
      throw new Error('Normal mode requires ".mocharc.json" (missing).');
    }

    const mocha = JSON.parse(fs.readFileSync(MOCHA_RC, "utf8"));
    const currentSpec = Array.isArray(mocha.spec) ? mocha.spec[0] : null;
    if (!currentSpec) {
      throw new Error('Invalid ".mocharc.json": expected { "spec": ["./test/X.test.js"] }.');
    }

    const currentFile = path.basename(currentSpec);
    const currentStep = parseFloat(currentFile);

    const tests = getAllTests();
    const passed = [];
    const locked = [];

    for (const t of tests) {
      if (t.step < currentStep) passed.push(t.file);
      if (t.step > currentStep) locked.push(t.file);
    }

    return addStats({
      current: currentFile,
      passed,
      locked,
      total: tests.length,
      next: locked[0] || "Congrats on completing this Challenge, no more test",
    });
  }

  function getResultTestMode() {
    const tests = getAllTests();
    const passed = tests.map((t) => t.file);
    const currentFile = tests.length ? tests[tests.length - 1].file : null;

    return addStats({
      current: currentFile,
      passed,
      locked: [],
      total: tests.length,
      next: null,
    });
  }

  app.get("/result", (req, res) => {
    try {
      const result = TEST_MODE ? getResultTestMode() : getResultNormal();
      res.json(whoIsAndWhere(result));
    } catch (err) {
      res.status(500).json({
        error: "Failed to read progress (normal mode)",
        message: err.message,
      });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    if (TEST_MODE) console.log("🧪 --test enabled (normal) → /result returns all passed");
    console.log(`🚀 Normal server running on port ${PORT}`);
  });
}

// ----------------------------
// PROJECT MODE implementation
// ----------------------------
function startProjectServer() {
  const app = express();
  attachCommonMiddleware(app);

  let isRunning = false;
  let lastCommandValue = null;
  let debounceTimer = null;

  function buildProjectResponseFromRun(runState) {
    const tests = getAllTests();

    if (tests.length === 0) {
      return addStats({
        current: null,
        passed: [],
        locked: [],
        total: 0,
        next: null,
        test: {
          file: null,
          passed: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          errorMessage: "No test files found in /test",
        },
      });
    }

    const currentFile = tests[0].file;
    const nextFile = tests.length > 1 ? tests[1].file : null;

    if (TEST_MODE) {
      return addStats({
        current: currentFile,
        passed: tests.map((t) => t.file),
        locked: [],
        total: tests.length,
        next: null,
        test: {
          file: currentFile,
          passed: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          errorMessage: "",
          forced: true,
        },
      });
    }

    if (!runState) {
      return addStats({
        current: currentFile,
        passed: [],
        locked: [],
        total: tests.length,
        next: currentFile,
        test: {
          file: currentFile,
          passed: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          errorMessage: "Waiting for the test to be completed",
        },
      });
    }

    const stdout = truncate(runState.stdout || "");
    const stderr = truncate(runState.stderr || "");
    const passed = !!runState.passed;

    return addStats({
      current: currentFile,
      passed: passed ? [currentFile] : [],
      locked: [],
      total: tests.length,
      next: passed ? nextFile : currentFile,
      test: {
        file: currentFile,
        passed,
        exitCode: runState.exitCode,
        stdout,
        stderr,
        errorMessage: passed
          ? ""
          : firstUsefulLine(stderr) || firstUsefulLine(stdout) || "Test failed",
      },
    });
  }

  function writeProjectResult(state, runState = null) {
    const payload = whoIsAndWhere({
      state,
      ...buildProjectResponseFromRun(runState),
    });

    safeWriteJson(RESULT_FILE, payload);
    return payload;
  }

  function ensureProjectFiles() {
    ensureDir(NEXT_COMMAND_FILE);

    if (!fs.existsSync(NEXT_COMMAND_FILE)) {
      fs.writeFileSync(NEXT_COMMAND_FILE, "");
    }

    if (!fs.existsSync(RESULT_FILE)) {
      writeProjectResult("finished", null);
    }
  }

  async function triggerProjectRun(reason = "file-change") {
    if (isRunning) {
      console.log(`⏭️ Project run ignored (${reason}) because a child is already running`);
      return;
    }

    isRunning = true;
    writeProjectResult("running", null);

    try {
      const tests = getAllTests();
      const currentFile = tests[0]?.file || null;

      if (!currentFile) {
        writeProjectResult("finished", {
          passed: false,
          exitCode: null,
          stdout: "",
          stderr: "",
        });
        return;
      }

      if (TEST_MODE) {
        writeProjectResult("finished", {
          passed: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
        });
        return;
      }

      const abs = path.join(TEST_DIR, currentFile);
      const run = await runMochaInChild(abs);
      writeProjectResult("finished", run);
    } catch (err) {
      writeProjectResult("finished", {
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: String(err?.stack || err?.message || err || "Unknown error"),
      });
    } finally {
      isRunning = false;
    }
  }

  function handleNextCommandChange() {
    const content = safeReadText(NEXT_COMMAND_FILE);
    const value = String(content || "").trim();

    if (!isRealCommand(value)) return;
    if (value === lastCommandValue) return;

    lastCommandValue = value;
    console.log("📝 .next_command changed → triggering project run");
    triggerProjectRun("next-command");
  }

  function watchNextCommandFile() {
    try {
      fs.watch(NEXT_COMMAND_FILE, () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handleNextCommandChange, 80);
      });
      console.log(`👀 Watching ${NEXT_COMMAND_FILE}`);
    } catch (err) {
      console.error("Failed to watch .next_command:", err.message);
    }
  }

  ensureProjectFiles();
  watchNextCommandFile();

  app.get("/result", (req, res) => {
    try {
      const result = safeReadJson(RESULT_FILE) || writeProjectResult("finished", null);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: "Failed to read progress (project mode)",
        message: err.message,
      });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log("📦 Project mode server (result.json + .next_command watcher)");
    if (TEST_MODE) console.log("🧪 --test enabled (project) → watcher writes all passed");
    console.log(`🚀 Project server running on port ${PORT}`);
  });
}

// ----------------------------
// Entry point
// ----------------------------
if (PROJECT_MODE) startProjectServer();
else startNormalServer();
