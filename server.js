const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const PORT = process.env.PORT || 3000;
const TEST_DIR = path.join(__dirname, "test");
const MOCHA_RC = path.join(__dirname, ".mocharc.json");
const RESULT_FILE = path.join(__dirname, "result.json");

const TEST_MODE = process.argv.includes("--test");
const PROJECT_MODE = process.argv.includes("--project");
const TEST_MAIL = process.argv.includes("--testmail");

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
    } catch {
      email = "";
    }
  }

  return {
    email,
    order: SELECTED_CHALLENGE?.order ?? null,
    ...payload,
  };
}

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
  return str.length > max
    ? str.slice(0, max) + `\n... (truncated ${str.length - max} chars)`
    : str;
}

function firstUsefulLine(text) {
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[0] || "";
}

function safeWriteJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to write JSON:", err.message);
  }
}

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("Failed to read JSON:", err.message);
    return fallback;
  }
}

function buildProjectPayload(base = {}) {
  return whoIsAndWhere(
    addStats({
      state: "finished",
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
        errorMessage: "",
      },
      ...base,
    })
  );
}

function readResultFile() {
  return safeReadJson(
    RESULT_FILE,
    buildProjectPayload({
      state: "finished",
      test: {
        file: null,
        passed: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        errorMessage: "",
      },
    })
  );
}

function writeResultFile(payload) {
  safeWriteJson(RESULT_FILE, payload);
}

function runMochaInChild(testFileAbsPath) {
  return new Promise((resolve) => {
    try {
      const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
      const args = ["mocha", testFileAbsPath];

      const proc = spawn(cmd, args, {
        cwd: __dirname,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      proc.stdout.on("data", (d) => {
        try {
          stdout += d.toString();
        } catch (err) {
          stderr += `\nstdout read error: ${err.message}`;
        }
      });

      proc.stderr.on("data", (d) => {
        try {
          stderr += d.toString();
        } catch (err) {
          stderr += `\nstderr read error: ${err.message}`;
        }
      });

      proc.on("close", (code) => {
        done({
          passed: code === 0,
          exitCode: code,
          stdout,
          stderr,
        });
      });

      proc.on("error", (err) => {
        done({
          passed: false,
          exitCode: 1,
          stdout,
          stderr: (stderr ? stderr + "\n" : "") + String(err?.stack || err?.message || err),
        });
      });
    } catch (err) {
      resolve({
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: String(err?.stack || err?.message || err),
      });
    }
  });
}

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
    console.log(`🚀 Normal server running on port ${PORT}`);
  });
}

let isProjectRunInProgress = false;

async function startProjectRun() {
  if (isProjectRunInProgress) return;

  isProjectRunInProgress = true;

  try {
    const tests = getAllTests();

    if (tests.length === 0) {
      writeResultFile(
        buildProjectPayload({
          state: "finished",
          total: 0,
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
      return;
    }

    const currentFile = tests[0].file;
    const nextFile = tests.length > 1 ? tests[1].file : null;

    writeResultFile(
      buildProjectPayload({
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
          errorMessage: "",
        },
      })
    );

    if (TEST_MODE) {
      writeResultFile(
        buildProjectPayload({
          state: "finished",
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
      );
      return;
    }

    const abs = path.join(TEST_DIR, currentFile);
    const run = await runMochaInChild(abs);

    const stdout = truncate(run.stdout);
    const stderr = truncate(run.stderr);

    writeResultFile(
      buildProjectPayload({
        state: "finished",
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
          errorMessage:
            run.passed
              ? ""
              : firstUsefulLine(stderr) || firstUsefulLine(stdout) || "Test failed",
        },
      })
    );
  } catch (err) {
    const current = readResultFile();

    writeResultFile(
      buildProjectPayload({
        ...current,
        state: "finished",
        test: {
          ...(current.test || {}),
          passed: false,
          exitCode: 1,
          stdout: current?.test?.stdout || "",
          stderr: truncate(
            (current?.test?.stderr ? current.test.stderr + "\n" : "") +
              String(err?.stack || err?.message || err)
          ),
          errorMessage: String(err?.message || err),
        },
      })
    );
  } finally {
    isProjectRunInProgress = false;
  }
}

function startProjectServer() {
  const app = express();
  attachCommonMiddleware(app);

  if (!fs.existsSync(RESULT_FILE)) {
    writeResultFile(
      buildProjectPayload({
        state: "finished",
        current: null,
        passed: [],
        locked: [],
        total: 0,
        next: null,
      })
    );
  }

  app.get("/result", (req, res) => {
    try {
      const currentResult = readResultFile();

      // always return current file as-is
      res.status(200).json(currentResult);

      // after responding, launch a new run only if not already running
      if (!isProjectRunInProgress) {
        setImmediate(() => {
          startProjectRun().catch((err) => {
            const current = readResultFile();
            writeResultFile(
              buildProjectPayload({
                ...current,
                state: "finished",
                test: {
                  ...(current.test || {}),
                  passed: false,
                  exitCode: 1,
                  stdout: current?.test?.stdout || "",
                  stderr: truncate(
                    (current?.test?.stderr ? current.test.stderr + "\n" : "") +
                      String(err?.stack || err?.message || err)
                  ),
                  errorMessage: String(err?.message || err),
                },
              })
            );
          });
        });
      }
    } catch (err) {
      return res.status(500).json({
        error: "Failed to read result.json (project mode)",
        message: err.message,
      });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Project server running on port ${PORT}`);
  });
}

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  if (PROJECT_MODE) {
    const current = readResultFile();
    writeResultFile(
      buildProjectPayload({
        ...current,
        state: "finished",
        test: {
          ...(current.test || {}),
          passed: false,
          exitCode: 1,
          stdout: current?.test?.stdout || "",
          stderr: truncate(
            (current?.test?.stderr ? current.test.stderr + "\n" : "") +
              String(err?.stack || err?.message || err)
          ),
          errorMessage: String(err?.message || err),
        },
      })
    );
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  if (PROJECT_MODE) {
    const current = readResultFile();
    writeResultFile(
      buildProjectPayload({
        ...current,
        state: "finished",
        test: {
          ...(current.test || {}),
          passed: false,
          exitCode: 1,
          stdout: current?.test?.stdout || "",
          stderr: truncate(
            (current?.test?.stderr ? current.test.stderr + "\n" : "") +
              String(reason?.stack || reason?.message || reason)
          ),
          errorMessage: String(reason?.message || reason),
        },
      })
    );
  }
});

if (PROJECT_MODE) startProjectServer();
else startNormalServer();
