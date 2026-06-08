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
      currentMenu["< Back"]();
      currentMenu["Debug"]();
      assert.strictEqual(typeof currentMenu["Full log"], "object");
      assert.strictEqual(typeof currentMenu["Partial log"], "object");
      assert.strictEqual(typeof currentMenu["Custom CORE only"], "object");
      assert.strictEqual(currentMenu["Debug log"], undefined);
    }
  },
  {
    name: "normal CORE and HRM status use neutral prompt instead of alert",
    async fn() {
      let currentMenu;
      let alertCalls = 0;
      let promptCalls = 0;
      const Bangle = {
        CORESensorPair() {},
        CORESensorConnect() { return Promise.resolve(); },
        CORESensorUnpair() { return Promise.resolve(); },
        CORESensorGetStatus() {
          return {
            state: "connected",
            paired: true,
            connected: true,
            lastError: "",
            hrm: {}
          };
        },
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
          alertCalls++;
          return Promise.resolve();
        },
        showPrompt() {
          promptCalls++;
          return Promise.resolve(true);
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
      currentMenu["Debug"]();
      await currentMenu["Status"]();
      currentMenu["< Back"]();
      currentMenu["HRM (ANT+)"]();
      await currentMenu["Status"]();

      assert.strictEqual(alertCalls, 0);
      assert.strictEqual(promptCalls, 2);
    }
  },
  {
    name: "cache rebuild success uses neutral success prompt instead of alert",
    async fn() {
      let currentMenu;
      let alertCalls = 0;
      let promptCalls = 0;
      const Bangle = {
        CORESensorPair() {},
        CORESensorConnect() { return Promise.resolve(); },
        CORESensorUnpair() { return Promise.resolve(); },
        CORESensorRebuildCache() { return Promise.resolve(); },
        CORESensorGetStatus() { return { state: "connected", paired: true, connected: true, hrm: {} }; },
        CORESensorHRMGetState() { return {}; },
        CORESensorHRMGetStatus() { return Promise.resolve({}); },
        isCORESensorOn() { return true; },
        setCORESensorPower() {},
        on() {},
        removeListener() {}
      };
      const E = {
        showMenu(menu) {
          currentMenu = menu;
        },
        showAlert() {
          alertCalls++;
          return Promise.resolve();
        },
        showPrompt() {
          promptCalls++;
          return Promise.resolve(true);
        },
        showMessage() {}
      };
      const g = {
        theme: { dark: false },
        clear() { return this; },
        setFont() { return this; },
        setFontAlign() { return this; },
        drawString() { return this; },
        setColor() { return this; },
        getWidth() { return 176; }
      };
      const storage = fakeStorage.create({
        "coretemp.json": {
          btid: "core-1",
          btname: "CORE"
        }
      });
      const loaded = loader.create({
        storage,
        globals: { Bangle, E, NRF: {}, g },
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
      currentMenu["Debug"]();
      await currentMenu["Rebuild cache"]();

      assert.strictEqual(alertCalls, 0);
      assert.strictEqual(promptCalls, 1);
    }
  },
  {
    name: "full and partial log toggles refresh mutually exclusive UI state",
    fn() {
      let currentMenu;
      const Bangle = {
        CORESensorPair() {},
        CORESensorConnect() { return Promise.resolve(); },
        CORESensorUnpair() { return Promise.resolve(); },
        CORESensorSetLogMode() {},
        CORESensorGetStatus() { return { state: "connected", paired: true, connected: true, hrm: {} }; },
        CORESensorHRMGetState() { return {}; },
        CORESensorHRMGetStatus() { return Promise.resolve({}); },
        isCORESensorOn() { return true; },
        setCORESensorPower() {}
      };
      const E = {
        showMenu(menu) {
          currentMenu = menu;
        },
        showAlert() { return Promise.resolve(); },
        showPrompt() { return Promise.resolve(true); },
        showMessage() {}
      };
      const storage = fakeStorage.create({
        "coretemp.json": {
          btid: "core-1",
          btname: "CORE",
          debugpartiallog: true
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
      currentMenu["Debug"]();
      assert.strictEqual(currentMenu["Full log"].value, false);
      assert.strictEqual(currentMenu["Partial log"].value, true);

      currentMenu["Full log"].onchange(true);
      assert.strictEqual(currentMenu["Full log"].value, true);
      assert.strictEqual(currentMenu["Partial log"].value, false);

      currentMenu["Partial log"].onchange(true);
      assert.strictEqual(currentMenu["Full log"].value, false);
      assert.strictEqual(currentMenu["Partial log"].value, true);
    }
  }
];
