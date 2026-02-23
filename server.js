/**
 * server.js (single file)
 *
 * Modes:
 *   node server.js                 -> NORMAL (reads .mocharc.json)
 *   node server.js --project       -> PROJECT (runs current test in child process)
 *   node server.js --test          -> force "all passed" (works in both)
 *   node server.js --project --test -> project + force pass
 *
 * PROJECT MODE response includes test output:
 *   test: { file, passed, exitCode, stdout, stderr, errorMessage }
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
import { execSync } from "node:child_process";

// ----------------------------
// Shared config + flags
// ----------------------------
const PORT = process.env.PORT || 3000;
const TEST_DIR = path.join(__dirname, "test");
const MOCHA_RC = path.join(__dirname, ".mocharc.json");

const TEST_MODE = process.argv.includes("--test");
const PROJECT_MODE = process.argv.includes("--project");

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
  { name: 'Learn Bash by Building a Boilerplate', uuid: 'a1B', order: 1 },
  { name: 'Learn Relational Databases by Building a Mario Database', uuid: 'c7D', order: 2 },
  { name: 'Celestial Bodies Database', uuid: 'e3F', order: 3 },
  { name: 'Learn Bash Scripting by Building Five Programs', uuid: 'g9H', order: 4 },
  { name: 'Learn SQL by Building a Student Database: Part 1', uuid: 'i2J', order: 5 },
  { name: 'Learn SQL by Building a Student Database: Part 2', uuid: 'k6L', order: 6 },
  { name: 'World Cup Database', uuid: 'm8N', order: 7 },
  { name: 'Learn Advanced Bash by Building a Kitty Ipsum Translator', uuid: 'p4Q', order: 8 },
  { name: 'Learn Bash and SQL by Building a Bike Rental Shop', uuid: 'r1S', order: 9 },
  { name: 'Salon Appointment Scheduler', uuid: 't5U', order: 10 },
  { name: 'Learn Nano by Building a Castle', uuid: 'v7W', order: 11 },
  { name: 'Learn Git by Building an SQL Reference Object', uuid: 'x2Y', order: 12 },
  { name: 'Periodic Table Database', uuid: 'z9A', order: 13 },
  { name: 'Number Guessing Game', uuid: 'b3C', order: 14 }
];

const SELECTED_CHALLENGE = REQUESTED_ID
  ? CHALLENGES.find((c) => c.uuid === REQUESTED_ID) || null
  : null;

function withOrder(payload) {
  return {
    order: SELECTED_CHALLENGE?.order ?? null, // ✅ first key
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

  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => /^\d+(\.\d+)?\.test\.js$/.test(f))
    .map((f) => ({ file: f, step: parseFloat(f) }))
    .sort((a, b) => a.step - b.step);
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
    // progress = passed %
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

/**
 * Encapsulated Mocha runner (child process)
 * - Uses `npx mocha <testFile>`
 * - Returns stdout/stderr/exit code to include in JSON
 */
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
      next: locked[0] || null,
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
      res.json(withOrder(result));
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

  async function getResultProjectMode() {
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

    // --test : force pass but keep consistent payload
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

    // Run only current test (encapsulated)
    const abs = path.join(TEST_DIR, currentFile);
    const run = await runMochaInChild(abs);

    const stdout = truncate(run.stdout);
    const stderr = truncate(run.stderr);

    return addStats({
      current: currentFile,
      passed: run.passed ? [currentFile] : [],
      locked: [],
      total: tests.length,
      next: run.passed ? nextFile : currentFile,

      // ✅ include test output/error info for the frontend
      test: {
        file: currentFile,
        passed: run.passed,
        exitCode: run.exitCode,
        stdout,
        stderr,
        // helpful single-line message (your test throws "Cannot connect to psql..." when DB down)
        errorMessage: run.passed ? "" : firstUsefulLine(stderr) || firstUsefulLine(stdout) || "Test failed",
      },
    });
  }

  app.get("/result", async (req, res) => {
    try {
      const result = await getResultProjectMode();
      res.json(withOrder(result));
    } catch (err) {
      res.status(500).json({
        error: "Failed to read progress (project mode)",
        message: err.message,
      });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log("📦 Project mode server (encapsulated mocha runner)");
    if (TEST_MODE) console.log("🧪 --test enabled (project) → /result returns all passed");
    console.log(`🚀 Project server running on port ${PORT}`);
  });
}

// ----------------------------
// Entry point
// ----------------------------
app.get("/me/email", (_req, res) => {
  try {
    const email = execSync("git config --get user.email", { encoding: "utf8" }).trim();
    res.json({ email: email || null });
  } catch {
    res.json({ email: null });
  }
});
if (PROJECT_MODE) startProjectServer();
else startNormalServer();


