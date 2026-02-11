// server.js

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});
app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  next();
});

const TEST_MODE = process.argv.includes("--test");

const TEST_DIR = path.join(__dirname, "test");
const MOCHA_RC = path.join(__dirname, ".mocharc.json");

function getAllTests() {
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => /^\d+\.test\.js$/.test(f))
    .map((f) => ({
      file: f,
      step: parseInt(f, 10),
    }))
    .sort((a, b) => a.step - b.step);
}

function addStats(payload) {
  const total = payload.total ?? (Array.isArray(payload.passed) || Array.isArray(payload.locked) ? (payload.total ?? 0) : 0);
  const passedCount = Array.isArray(payload.passed) ? payload.passed.length : 0;
  const lockedCount = Array.isArray(payload.locked) ? payload.locked.length : 0;

  const denom = total > 0 ? total : 1; // avoid division by 0
  const passedPercent = Math.round((passedCount / denom) * 100);
  const lockedPercent = Math.round((lockedCount / denom) * 100);

  return {
    ...payload,
    totalCount: total,
    passedCount,
    lockedCount,
    passedPercent,
    lockedPercent,
    // keep your original "progress" field but make it explicitly the passed percentage
    progress: total > 0 ? passedPercent : 0,
  };
}

/**
 * Normal mode: compute from .mocharc.json current spec
 */
function getResultNormal() {
  const mocha = JSON.parse(fs.readFileSync(MOCHA_RC, "utf8"));

  const currentSpec = mocha.spec[0]; // "./test/20.test.js"
  const currentFile = path.basename(currentSpec);
  const currentStep = parseInt(currentFile, 10);

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

/**
 * Test mode: force "everything passed" but keep real totals
 */
function getResultTestMode() {
  const tests = getAllTests();
  const passed = tests.map((t) => t.file);

  // keep "current" consistent with your schema (a string)
  // choose the last test file as "current" when everything is passed
  const currentFile = tests.length ? tests[tests.length - 1].file : "0.test.js";

  return addStats({
    current: currentFile,
    passed,
    locked: [],
    total: tests.length,
    next: null,
  });
}

// serve result
app.get("/result", (req, res) => {
  try {
    const result = TEST_MODE ? getResultTestMode() : getResultNormal();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: "Failed to read progress",
      message: err.message,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  if (TEST_MODE) console.log("🧪 Test mode enabled → /result returns all passed");
  console.log(`🚀 Result server running on port ${PORT}`);
});

