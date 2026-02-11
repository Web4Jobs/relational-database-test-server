// server.js

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  next();
});

const TEST_MODE = process.argv.includes("--test");

const TEST_DIR = path.join(__dirname, "test");
const MOCHA_RC = path.join(__dirname, ".mocharc.json");

/**
 * Normal progress mode
 */
function getResult() {
  const mocha = JSON.parse(fs.readFileSync(MOCHA_RC, "utf8"));
  const currentSpec = mocha.spec[0];
  const currentFile = path.basename(currentSpec);
  const currentStep = parseInt(currentFile, 10);

  const tests = fs
    .readdirSync(TEST_DIR)
    .filter((f) => /^\d+\.test\.js$/.test(f))
    .map((f) => ({
      file: f,
      step: parseInt(f, 10),
    }))
    .sort((a, b) => a.step - b.step);

  const passed = [];
  const locked = [];

  for (const t of tests) {
    if (t.step < currentStep) passed.push(t.file);
    if (t.step > currentStep) locked.push(t.file);
  }

  return {
    current: currentFile,
    passed,
    locked,
    total: tests.length,
    progress: Math.round((passed.length / tests.length) * 100),
    next: locked[0] || null,
  };
}

/**
 * /result endpoint
 */
app.get("/result", (req, res) => {
  try {
    // 🔥 If launched with --test → force ALL PASSED
    if (TEST_MODE) {
      return res.json({
        current: null,
        passed: "ALL",
        locked: [],
        total: 0,
        progress: 100,
        next: null,
      });
    }

    // normal behavior
    res.json(getResult());
  } catch (err) {
    res.status(500).json({
      error: "Failed to read progress",
      message: err.message,
    });
  }
});

/**
 * Start server
 */
app.listen(PORT, "0.0.0.0", () => {
  if (TEST_MODE) {
    console.log("🧪 Test mode enabled → All tests will be marked as passed");
  }
  console.log(`🚀 Result server running on port ${PORT}`);
});
