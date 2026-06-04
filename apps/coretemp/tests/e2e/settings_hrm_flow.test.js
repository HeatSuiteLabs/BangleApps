const assert = require("assert");
const loader = require("../helpers/module_loader");
const fakeStorage = require("../helpers/fake_storage");

module.exports = [
  {
    name: "settings menu shows HRM actions for paired CORE",
    fn() {
      let currentMenu;
      let statusCalls = 0;
      const Bangle = {
        CORESensorPair() {},
        CORESensorConnect() { return Promise.resolve(); },
        CORESensorUnpair() { return Promise.resolve(); },
        CORESensorHRMGetState() {
          return {
            pairedSensors: [],
            recent: [],
            pairedCount: 0,
            paired: false,
            busy: false
          };
        },
        CORESensorHRMGetStatus() {
          statusCalls++;
          return Promise.resolve({
            pairedSensors: [],
            recent: [],
            pairedCount: 0,
            paired: false
          });
        },
        isCORESensorOn() { return true; },
        setCORESensorPower() {}
      };
      const E = {
        showMenu(menu) {
          currentMenu = menu;
        },
        showAlert() {
          return Promise.resolve();
        },
        showPrompt() {
          return Promise.resolve(false);
        },
        showMessage() {}
      };
      const storage = fakeStorage.create({
        "coretemp.json": {
          btid: "core-1",
          btname: "CORE"
        }
      });
      const loaded = loader.create({
        storage,
        globals: { Bangle, E, NRF: {} },
        overrides: {
          "coretemp.store": {
            read() { return storage.readJSON("coretemp.json", 1) || {}; },
            write(mutator) {
              const next = storage.readJSON("coretemp.json", 1) || {};
              mutator(next);
              storage.writeJSON("coretemp.json", next);
              return next;
            },
            log() {}
          }
        }
      });
      loaded.require("coretemp.settingsui").open(function () {});
      assert.strictEqual(typeof currentMenu["HRM (ANT+)"], "function");
      assert.strictEqual(statusCalls, 0);
      currentMenu["HRM (ANT+)"]();
      assert.strictEqual(statusCalls, 0);
      assert.strictEqual(typeof currentMenu["Status"], "function");
      assert.strictEqual(typeof currentMenu["Scan ANT+"], "function");
      assert.strictEqual(typeof currentMenu["Recent HRMs"], "function");
      assert.strictEqual(currentMenu["Manual ANT ID"], undefined);
      assert.strictEqual(typeof currentMenu["Clear Paired HRM"], "function");
    }
  }
];
