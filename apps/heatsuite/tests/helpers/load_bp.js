/* eslint-env node */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "../..");
const bpPath = path.join(root, "heatsuite.bp.js");

function createTimers() {
  let nextId = 1;
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = {
        id: nextId++,
        fn,
        ms,
        cleared: false
      };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const timer = timers.find(t => t.id === id);
      if (timer) timer.cleared = true;
    },
    runByMs(ms) {
      const due = timers.filter(t => !t.cleared && t.ms === ms);
      due.forEach(t => {
        t.cleared = true;
        t.fn();
      });
      return due.length;
    },
    runAll() {
      const due = timers.filter(t => !t.cleared);
      due.forEach(t => {
        t.cleared = true;
        t.fn();
      });
      return due.length;
    }
  };
}

function create(options) {
  options = options || {};
  const settings = options.settings || {};
  const saved = [];
  const layouts = [];
  const logs = [];
  const gClears = [];
  const loads = [];
  const timers = createTimers();
  const hsModule = options.hsModule || {
    getSettings() {
      return settings;
    },
    saveDataToFile(type, task, data) {
      saved.push({
        type,
        task,
        data: Object.assign({}, data)
      });
      return true;
    },
    log(msg) {
      logs.push(String(msg));
    }
  };

  function Layout(def, layoutOptions) {
    this.def = def;
    this.options = layoutOptions;
    this.render = function () {
      layouts.push(def);
    };
  }

  function localRequire(name) {
    if (name === "Layout") return Layout;
    if (name === "HSModule") return hsModule;
    return require(name);
  }

  const context = {
    require: localRequire,
    console: {
      log() {
        logs.push(Array.prototype.slice.call(arguments).join(" "));
      }
    },
    NRF: options.NRF || { connect() { throw new Error("Unexpected NRF.connect"); } },
    Bangle: options.Bangle || {
      load() {
        loads.push(true);
      }
    },
    g: options.g || {
      clear() {
        gClears.push(true);
      }
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Promise,
    Uint8Array,
    DataView,
    ArrayBuffer,
    Date: options.Date || Date,
    Math,
    Error,
    String,
    Number,
    Infinity,
    JSON
  };
  context.globalThis = context;

  const code = fs.readFileSync(bpPath, "utf8") +
    "\nglobalThis.__bpTestExports = {" +
    "decodeSFloat16: decodeSFloat16," +
    "parseBPMeasurement: parseBPMeasurement," +
    "getBP: getBP," +
    "startBP: startBP" +
    "};";

  vm.runInNewContext(code, context, { filename: bpPath });

  return {
    exports: context.__bpTestExports,
    context,
    settings,
    saved,
    layouts,
    logs,
    loads,
    gClears,
    timers
  };
}

module.exports = {
  create
};
