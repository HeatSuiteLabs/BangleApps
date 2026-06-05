const assert = require("assert");
const loader = require("../helpers/module_loader");
const fakeStorage = require("../helpers/fake_storage");

function createGraphics() {
  return {
    theme: { dark: false },
    getWidth() { return 176; },
    getHeight() { return 176; },
    clear() { return this; },
    reset() { return this; },
    setFont() { return this; },
    setFontAlign() { return this; },
    clearRect() { return this; },
    setColor() { return this; },
    drawString() { return this; },
    drawImage() { return this; }
  };
}

module.exports = [
  {
    name: "boot loads runtime only when background is enabled",
    fn() {
      let enableCount = 0;
      let powerCalls = [];
      const loaded = loader.create({
        storage: fakeStorage.create({
          "coretemp.json": { enabled: true }
        }),
        globals: {
          Bangle: {
            setCORESensorPower(on, owner) {
              powerCalls.push([on, owner]);
            }
          }
        },
        overrides: {
          CORESensor: {
            enable() {
              enableCount++;
            }
          }
        }
      });

      loaded.require("coretemp.boot");

      assert.strictEqual(enableCount, 1);
      assert.deepStrictEqual(powerCalls, []);
    }
  },
  {
    name: "foreground app uses temporary COREAPP owner without enabling background",
    fn() {
      let enableCount = 0;
      let killHandler;
      const powerCalls = [];
      const listeners = {};
      const storage = fakeStorage.create({
        "coretemp.json": { enabled: false, btid: "core-1" }
      });
      const Bangle = {
        loadWidgets() {},
        drawWidgets() {},
        on(name, handler) {
          listeners[name] = handler;
        },
        removeListener(name, handler) {
          if (listeners[name] === handler) delete listeners[name];
        },
        setCORESensorPower(on, owner) {
          powerCalls.push([on, owner]);
        }
      };
      const loaded = loader.create({
        storage,
        globals: {
          Bangle,
          E: {
            on(name, handler) {
              if (name === "kill") killHandler = handler;
            }
          },
          g: createGraphics(),
          atob() {
            return "";
          },
          process: { env: { HWVERSION: 2 } }
        },
        overrides: {
          heatshrink: {
            decompress() {
              return "";
            }
          },
          CORESensor: {
            enable() {
              enableCount++;
            }
          }
        }
      });

      loaded.require("coretemp.app");

      assert.strictEqual(enableCount, 1);
      assert.strictEqual(typeof listeners.CORESensor, "function");
      assert.deepStrictEqual(powerCalls, [[1, "COREAPP"]]);
      assert.strictEqual(storage.readJSON("coretemp.json", 1).enabled, false);

      killHandler();

      assert.strictEqual(listeners.CORESensor, undefined);
      assert.deepStrictEqual(powerCalls, [[1, "COREAPP"], [0, "COREAPP"]]);
      assert.strictEqual(storage.readJSON("coretemp.json", 1).enabled, false);
    }
  }
];
