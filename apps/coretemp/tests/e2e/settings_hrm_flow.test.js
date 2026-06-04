const assert = require("assert");
const loader = require("../helpers/module_loader");
const fakeStorage = require("../helpers/fake_storage");

module.exports = [
  {
    name: "settings menu shows HRM actions for paired CORE",
    fn() {
      let currentMenu;
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
      assert.strictEqual(typeof currentMenu["Heart Rate"], "function");
      currentMenu["Heart Rate"]();
      assert.strictEqual(typeof currentMenu["Status"], "function");
      assert.strictEqual(typeof currentMenu["Scan ANT+"], "function");
      assert.strictEqual(typeof currentMenu["Recent HRMs"], "function");
      assert.strictEqual(typeof currentMenu["Manual ANT ID"], "function");
      assert.strictEqual(typeof currentMenu["Clear Paired HRM"], "function");
    }
  }
];
