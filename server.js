// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS (open)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// simple request log
app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  next();
});

const TEST_MODE = process.argv.includes("--test"); // node server.js --test
const PROJECT_MODE = process.argv.includes("--project"); // node server.js --project

const TEST_DIR = path.join(__dirname, "test");
const MOCHA_RC = path.join(__dirname, ".mocharc.json");

// supports: 1.test.js, 20.test.js, 1.1.test.js, 10.25.test.js
function getAllTests() {
  if (!fs.existsSync(TEST_DIR)) return [];

  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => /^\d+(\.\d+)?\.test\.js$/.test(f))
    .map((f) => ({
      file: f,
      step: parseFloat(f), // ✅ handles 1.1
    }))
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
    // keep your original "progress" field as "passed %" (like before)
    progress: total > 0 ? passedPercent : 0,
  };
}

/**
 * Normal mode: compute from .mocharc.json current spec
 * Falls back to project mode if .mocharc.json is missing/invalid.
 */
function getResultNormal() {
  if (!fs.existsSync(MOCHA_RC)) {
    return getResultProjectMode();
  }

  const mocha = JSON.parse(fs.readFileSync(MOCHA_RC, "utf8"));
  const currentSpec = Array.isArray(mocha.spec) ? mocha.spec[0] : null;
  if (!currentSpec) return getResultProjectMode();

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

/**
 * Project mode: no .mocharc.json, so we choose "current" deterministically.
 * - If only one test exists (like 1.1.test.js), current = that file
 * - next = second file if exists
 */
function getResultProjectMode() {
  const tests = getAllTests();

  const currentFile = tests.length ? tests[0].file : null;
  const nextFile = tests.length > 1 ? tests[1].file : null;

  // In project mode we can’t know which ones passed unless you track it elsewhere,
  // so we return empty passed/locked by default.
  return addStats({
    current: currentFile,
    passed: [],
    locked: [],
    total: tests.length,
    next: nextFile,
  });
}

/**
 * Test mode: force "everything passed" but keep real totals
 */
function getResultTestMode() {
  const tests = getAllTests();
  const passed = tests.map((t) => t.file);

  // choose last file as "current" when everything is passed
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
    const result = TEST_MODE
      ? getResultTestMode()
      : PROJECT_MODE
      ? getResultProjectMode()
      : getResultNormal();

    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: "Failed to read progress",
      message: err.message,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  if (TEST_MODE) console.log("🧪 --test enabled → /result returns all passed");
  if (PROJECT_MODE) console.log("📦 --project enabled → /result works without .mocharc.json");
  console.log(`🚀 Result server running on port ${PORT}`);
});
