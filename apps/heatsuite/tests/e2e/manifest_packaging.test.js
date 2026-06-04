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
  }
];
