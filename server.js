/**
 * server.js
 *
 * One-file distribution ✅
 * - Normal mode logic kept in startNormalServer()
 * - Project mode logic kept in startProjectServer()
 * - Entry point selects mode by flags:
 *    node server.js               -> normal (uses .mocharc.json)
 *    node server.js --project     -> project (runs test file in child process)
 *    node server.js --test        -> force "all passed" (works in both)
 *    node server.js --project --test -> project + force pass
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ----------------------------
// Shared utilities
// ----------------------------
const PORT = process.env.PORT || 3000;
const TEST_DIR = path.join(__dirname, "test");
const MOCHA_RC = path.join(__dirname, ".mocharc.json");

const TEST_MODE = process.argv.includes("--test");
const PROJECT_MODE = process.argv.includes("--project");

function attachCommonMiddleware(app) {
  // CORS (open)
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    next();
  });

  // simple log
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
    // keep your original "progress" field as "passed %"
    progress: total > 0 ? passedPercent : 0,
  };
}

/**
 * Encapsulated test runner (child process)
 * Runs a SINGLE test file using `npx mocha <file>`.
 * - returns { passed: boolean, exitCode, stdout, stderr }
 */
function runMochaInChild(testFileAbsPath) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["mocha", testFileAbsPath],
      {
        cwd: __dirname,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

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
        stderr: (stderr ? stderr + "\n" : "") + err.message,
      });
    });
  });
}

// ----------------------------
// Normal mode implementation
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

    const currentFile = path.basename(currentSpec); // e.g. "20.test.js" or "1.1.test.js"
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
// Project mode implementation
// ----------------------------
function startProjectServer() {
  const app = express();
  attachCommonMiddleware(app);

  /**
   * In project mode:
   * - no .mocharc.json needed
   * - current = first test file (sorted)
   * - runs current test in child process to decide passed[]
   */
  async function getResultProjectMode() {
    const tests = getAllTests();

    if (tests.length === 0) {
      return addStats({
        current: null,
        passed: [],
        locked: [],
        total: 0,
        next: null,
      });
    }

    const currentFile = tests[0].file;
    const nextFile = tests.length > 1 ? tests[1].file : null;

    if (TEST_MODE) {
      // Force pass (no execution)
      return addStats({
        current: currentFile,
        passed: tests.map((t) => t.file), // treat all as passed in test mode
        locked: [],
        total: tests.length,
        next: null,
      });
    }

    // Run only current test (encapsulated)
    const abs = path.join(TEST_DIR, currentFile);
    const run = await runMochaInChild(abs);

    return addStats({
      current: currentFile,
      passed: run.passed ? [currentFile] : [],
      locked: [], // you can extend this later for unlocking logic
      total: tests.length,
      next: run.passed ? nextFile : currentFile, // if failed, "next" stays current
      // Optional debug fields (remove if you don't want them exposed)
      // mochaExitCode: run.exitCode,
      // mochaStdout: run.stdout,
      // mochaStderr: run.stderr,
    });
  }

  app.get("/result", async (req, res) => {
    try {
      const result = await getResultProjectMode();
      res.json(result);
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
if (PROJECT_MODE) startProjectServer();
else startNormalServer();
