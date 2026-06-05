/* eslint-env node */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

module.exports = [
  {
    name: "metadata includes BP app but excludes tests",
    fn() {
      const root = path.resolve(__dirname, "../..");
      const metadata = JSON.parse(fs.readFileSync(path.join(root, "metadata.json"), "utf8"));
      const entries = metadata.storage.concat(metadata.data || []);
      const urls = entries.map(entry => entry.url || entry.name || "");
      assert.ok(urls.includes("heatsuite.bp.js"));
      assert.strictEqual(urls.some(url => /(^|\/)tests\//.test(url)), false);
    }
  },
  {
    name: "metadata packages starter data for fresh installs",
    fn() {
      const root = path.resolve(__dirname, "../..");
      const metadata = JSON.parse(fs.readFileSync(path.join(root, "metadata.json"), "utf8"));
      const entries = metadata.storage.concat(metadata.data || []);
      const byName = Object.fromEntries(entries.map(entry => [entry.name, entry]));

      assert.strictEqual(byName["heatsuite.settings.json"].url, "heatsuite.settings.json");
      assert.strictEqual(byName["heatsuite.tasks.json"].url, "heatsuite.tasks.json");
      assert.strictEqual(byName["heatsuite.survey.json"].url, "heatsuite.survey.json");
      assert.strictEqual(byName["heatsuite.default.json"], undefined);

      const settings = JSON.parse(fs.readFileSync(path.join(root, "heatsuite.settings.json"), "utf8"));
      assert.ok(Array.isArray(settings.record));
      assert.ok(settings.record.includes("bat"));
    }
  }
];
