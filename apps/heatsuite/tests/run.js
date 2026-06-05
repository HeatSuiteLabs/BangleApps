/* eslint-env node */
const path = require("path");

const files = [
  "unit/bp_parser.test.js",
  "behaviour/bp_runtime.test.js",
  "e2e/manifest_packaging.test.js"
];

async function run() {
  let failures = 0;
  for (const file of files) {
    const fullPath = path.join(__dirname, file);
    const tests = require(fullPath);
    for (const testCase of tests) {
      try {
        await testCase.fn();
        console.log("ok - " + file + " - " + testCase.name);
      } catch (err) {
        failures++;
        console.error("not ok - " + file + " - " + testCase.name);
        console.error(err && err.stack ? err.stack : err);
      }
    }
  }
  if (failures) process.exitCode = 1;
}

run().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
