/**
 * server.js (single file)
 *
 * Modes:
 *   node server.js                 -> NORMAL (reads .mocharc.json)
 *   node server.js --project       -> PROJECT (runs current test in child process)
 *   node server.js --test          -> force "all passed" (works in both)
 *   node server.js --project --test -> project + force pass
 *
 * PROJECT MODE:
 *   - first /result call creates result.json with state: "running"
 *   - responds immediately with that file content
 *   - mocha continues in background
 *   - when finished, result.json is replaced with final payload
 *   - later /result calls just serve result.json
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

// ----------------------------
// Shared config + flags
// ----------------------------
const PORT = process.env.PORT || 3000;
const TEST_DIR = path.join(__dirname, "test");
const MOCHA_RC = path.join(__dirname, ".mocharc.json");
const RESULT_FILE = path.join(__dirname, "result.json");

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
  { name: "Number Guessing Game", uuid: "b3C", order: 14 }
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

function writeResultFile(data) {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to write result.json:", err.message);
  }
}

function readResultFile() {
  try {
    if (!fs.existsSync(RESULT_FILE)) return null;
    return JSON.parse(fs.readFileSync(RESULT_FILE, "utf8"));
  } catch (err) {
    console.error("Failed to read result.json:", err.message);
    return null;
  }
}

function removeResultFile() {
  try {
    if (fs.existsSync(RESULT_FILE)) fs.unlinkSync(RESULT_FILE);
  } catch (err) {
    console.error("Failed to remove result.json:", err.message);
  }
}

function makeRunningPayload(currentFile, tests, nextFile) {
  return whoIsAndWhere(
    addStats({
      state: "running",
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
        errorMessage: "Test is still running",
      },
    })
  );
}

function makeFinalPayload({ currentFile, tests, nextFile, run }) {
  const stdout = truncate(run.stdout);
  const stderr = truncate(run.stderr);

  return whoIsAndWhere(
    addStats({
      state: "completed",
      current: currentFile,
      passed: run.passed ? [currentFile] : [],
      locked: [],
      total: tests.length,
      next: run.passed ? nextFile : currentFile,
      test: {
        file: currentFile,
        passed: run.passed,
        exitCode: run.exitCode,
        stdout,
        stderr,
        errorMessage: run.passed
          ? ""
          : firstUsefulLine(stderr) || firstUsefulLine(stdout) || "Test failed",
      },
    })
  );
}

function makeFailedPayload(currentFile, tests, err) {
  return whoIsAndWhere(
    addStats({
      state: "failed",
      current: currentFile,
      passed: [],
      locked: [],
      total: tests.length,
      next: currentFile,
      test: {
        file: currentFile,
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: String(err?.stack || err?.message || err || "Unknown error"),
        errorMessage: String(err?.message || err || "Unknown error"),
      },
    })
  );
}

function runMochaInChild(testFileAbsPath) {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
    const args = ["mocha", testFileAbsPath];

    const proc = spawn(cmd, args, {
      cwd: __dirname,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

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

    return whoIsAndWhere(
      addStats({
        state: "completed",
        current: currentFile,
        passed,
        locked,
        total: tests.length,
        next: locked[0] || "Congrats on completing this Challenge, no more test",
      })
    );
  }

  function getResultTestMode() {
    const tests = getAllTests();
    const passed = tests.map((t) => t.file);
    const currentFile = tests.length ? tests[tests.length - 1].file : null;

    return whoIsAndWhere(
      addStats({
        state: "completed",
        current: currentFile,
        passed,
        locked: [],
        total: tests.length,
        next: null,
      })
    );
  }

  app.get("/result", (req, res) => {
    try {
      const result = TEST_MODE ? getResultTestMode() : getResultNormal();
      res.json(result);
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

  let runPromise = null;

  async function startBackgroundRun() {
    const tests = getAllTests();

    if (tests.length === 0) {
      writeResultFile(
        whoIsAndWhere(
          addStats({
            state: "failed",
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
          })
        )
      );
      return;
    }

    const currentFile = tests[0].file;
    const nextFile = tests.length > 1 ? tests[1].file : null;

    if (TEST_MODE) {
      writeResultFile(
        whoIsAndWhere(
          addStats({
            state: "completed",
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
          })
        )
      );
      return;
    }

    const runningPayload = makeRunningPayload(currentFile, tests, nextFile);
    writeResultFile(runningPayload);

    try {
      const abs = path.join(TEST_DIR, currentFile);
      const run = await runMochaInChild(abs);
      const finalPayload = makeFinalPayload({ currentFile, tests, nextFile, run });
      writeResultFile(finalPayload);
    } catch (err) {
      writeResultFile(makeFailedPayload(currentFile, tests, err));
    } finally {
      runPromise = null;
    }
  }

  app.get("/result", async (req, res) => {
    try {
      const existing = readResultFile();

      if (existing) {
        if (existing.state === "running" && !runPromise) {
          runPromise = startBackgroundRun();
        }
        return res.json(existing);
      }

      const tests = getAllTests();
      if (tests.length === 0) {
        const payload = whoIsAndWhere(
          addStats({
            state: "failed",
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
          })
        );
        writeResultFile(payload);
        return res.json(payload);
      }

      if (!runPromise) {
        runPromise = startBackgroundRun();
      }

      const initialPayload = readResultFile() || makeRunningPayload(tests[0].file, tests, tests[1]?.file || null);
      return res.json(initialPayload);
    } catch (err) {
      res.status(500).json({
        error: "Failed to read progress (project mode)",
        message: err.message,
      });
    }
  });

  app.get("/result/reset", (req, res) => {
    runPromise = null;
    removeResultFile();
    res.json({ ok: true, message: "result.json removed" });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log("📦 Project mode server (result.json polling mode)");
    if (TEST_MODE) console.log("🧪 --test enabled (project) → /result returns all passed");
    console.log(`🚀 Project server running on port ${PORT}`);
  });
}

// ----------------------------
// Entry point
// ----------------------------
if (PROJECT_MODE) startProjectServer();
else startNormalServer();
