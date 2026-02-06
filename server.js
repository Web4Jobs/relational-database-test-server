// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
app.use((req, res, next) => {
  console.log("➡️", req.method, req.url);
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});
const PORT = process.env.PORT || 3000;

const TEST_DIR = path.join(__dirname, "test");
const MOCHA_RC = path.join(__dirname, ".mocharc.json");

function getResult() {
	// read .mocharc.json
	const mocha = JSON.parse(fs.readFileSync(MOCHA_RC, "utf8"));

	const currentSpec = mocha.spec[0]; // "./test/20.test.js"
	const currentFile = path.basename(currentSpec);
	const currentStep = parseInt(currentFile, 10);

	// read & sort test files numerically
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

// serve result
app.get("/result", (req, res) => {
	try {
		res.json(getResult());
	} catch (err) {
		res.status(500).json({
			error: "Failed to read progress",
			message: err.message,
		});
	}
});

app.listen(PORT, "0.0.0.0", () => {
	console.log(`🚀 Result server running on port ${PORT}`);
});


