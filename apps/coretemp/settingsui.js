exports.open = function (back) {
  var store = require("coretemp.store");
  var settings = {};
  var OWNER = "coretemp.settings";
  var BACKGROUND_OWNER = "coretemp.enabled";

  function readSettings() {
    settings = store.read();
  }

  function writeSetting(key, value) {
    store.write(function (nextSettings) {
      if (value === undefined) delete nextSettings[key];
      else nextSettings[key] = value;
    });
    readSettings();
    if (key === "enabled" && Bangle.setCORESensorPower) {
      Bangle.setCORESensorPower(!!value, BACKGROUND_OWNER);
    }
    if (key === "debuglog" && Bangle.CORESensorSetDebugLog) {
      Bangle.CORESensorSetDebugLog(!!value);
    }
  }

  function showNext(next) {
    var result;
    if (!next) return;
    result = next();
    if (result && typeof result === "object" && result[""]) E.showMenu(result);
    return result;
  }

  function ensureRuntime() {
    if (!Bangle.CORESensorPair) {
      try {
        require("CORESensor").enable();
      } catch (e) {
        return false;
      }
    }
    return !!Bangle.CORESensorPair;
  }

  function runWithCoreConnection(fn, skipConnect) {
    var acquiredPower = false;
    var promise = Promise.resolve();
    if (!ensureRuntime()) return Promise.reject(new Error("CORESensor runtime is unavailable"));
    if (Bangle.setCORESensorPower && Bangle.isCORESensorOn && !Bangle.isCORESensorOn()) {
      Bangle.setCORESensorPower(1, OWNER);
      acquiredPower = true;
    }
    if (!skipConnect) promise = promise.then(function () { return Bangle.CORESensorConnect(); });
    promise = promise.then(fn);
    return promise.then(function (result) {
      if (acquiredPower) Bangle.setCORESensorPower(0, OWNER);
      return result;
    }, function (err) {
      if (acquiredPower) Bangle.setCORESensorPower(0, OWNER);
      throw err;
    });
  }

  function formatError(err) {
    if (err === undefined || err === null) return String(err);
    if (err instanceof Error) return err.message || String(err);
    if (typeof err === "string") return err;
    if (typeof err === "object" && err.message) return String(err.message);
    if (err && err.length !== undefined && typeof err !== "function") return String(err);
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }

  function showError(title, err, next) {
    return E.showAlert(title + "\n" + formatError(err)).then(function () {
      return showNext(next);
    });
  }

  function showCoreStatus() {
    var status;
    if (!ensureRuntime() || !Bangle.CORESensorGetStatus) {
      return E.showAlert("Runtime unavailable").then(function () {
        E.showMenu(debugMenu());
      });
    }
    status = Bangle.CORESensorGetStatus();
    return E.showAlert(
      "State: " + status.state + "\n" +
      "Task: " + (status.activeTask || "") + "\n" +
      "Paired: " + status.paired + "\n" +
      "Connected: " + status.connected + "\n" +
      "Error: " + (status.lastError || "")
    ).then(function () {
      E.showMenu(debugMenu());
    });
  }

  function rebuildCache() {
    E.showMenu();
    E.showMessage("Rebuilding...");
    return runWithCoreConnection(function () {
      return Bangle.CORESensorRebuildCache();
    }, true).then(function () {
      return E.showAlert("Cache rebuilt").then(function () {
        E.showMenu(debugMenu());
      });
    }).catch(function (err) {
      return showError("Error rebuilding cache", err, debugMenu);
    });
  }

  function connectToDevice() {
    E.showMenu();
    E.showMessage("Connecting...");
    return runWithCoreConnection(function () {
      return Promise.resolve();
    }).then(function () {
      readSettings();
      E.showMenu(buildMainMenu());
    }).catch(function (err) {
      return showError("Error during connect", err, buildMainMenu);
    });
  }

  function formatCoreName() {
    return settings.btname || settings.btid;
  }

  function openHeartRatePlaceholder() {
    return E.showAlert("Heart Rate\nintegration\nunavailable").then(function () {
      E.showMenu(buildMainMenu());
    });
  }

  function debugMenu() {
    return {
      "": { title: "Debug" },
      "< Back": function () { E.showMenu(buildMainMenu()); },
      "Alert on disconnect": {
        value: !!settings.warnDisconnect,
        onchange: function (v) { writeSetting("warnDisconnect", v); }
      },
      "Debug log": {
        value: !!settings.debuglog,
        onchange: function (v) { writeSetting("debuglog", v); }
      },
      "Status": showCoreStatus,
      "Rebuild cache": rebuildCache
    };
  }

  function scanForCoreSensor() {
    var menu = { "< Back": function () { E.showMenu(buildMainMenu()); } };
    E.showMenu();
    E.showMessage("Scanning for\n5 seconds");
    NRF.findDevices(function (devices) {
      if (!devices) devices = [];
      menu[""] = { title: "Scan (" + devices.length + ")" };
      if (!devices.length) {
        return E.showAlert("No devices found").then(function () {
          E.showMenu(buildMainMenu());
        });
      }
      devices.forEach(function (device) {
        var shown = device.name || device.id.substr(0, 17);
        menu[shown] = function () {
          E.showPrompt("Pair with\n" + shown + "?").then(function (confirmed) {
            if (!confirmed) return E.showMenu(menu);
            E.showMenu();
            E.showMessage("Pairing with\n" + shown + "\n...");
            runWithCoreConnection(function () {
              return Bangle.CORESensorPair(device).then(function (result) {
                readSettings();
                if (settings.enabled && Bangle.setCORESensorPower) {
                  Bangle.setCORESensorPower(1, BACKGROUND_OWNER);
                }
                return result;
              });
            }, true).then(function () {
              readSettings();
              return E.showPrompt("CORE paired", {
                title: "Success",
                buttons: { "OK": true }
              }).then(function () {
                E.showMenu(buildMainMenu());
              });
            }).catch(function (err) {
              showError("Error during pairing", err, buildMainMenu);
            });
          });
        };
      });
      E.showMenu(menu);
    }, {
      timeout: 5000,
      active: true,
      filters: [{ services: ["00002100-5b1e-4347-b07c-97b514dae121"] }]
    });
  }

  function buildMainMenu() {
    var menu = {
      "": { title: "CORE Sensor" },
      "< Back": back,
      "Enable": {
        value: !!settings.enabled,
        onchange: function (v) { writeSetting("enabled", v); }
      },
      "Widget": {
        value: !!settings.widget,
        onchange: function (v) { writeSetting("widget", v); }
      }
    };
    if (settings.btname || settings.btid) {
      menu["Unpair " + formatCoreName()] = function () {
        E.showPrompt("Unpair current device?").then(function (confirmed) {
          if (!confirmed) return E.showMenu(buildMainMenu());
          Promise.resolve(Bangle.CORESensorUnpair()).then(function () {
            readSettings();
            E.showMenu(buildMainMenu());
          }).catch(function (err) {
            showError("Error during unpair", err, buildMainMenu);
          });
        });
      };
      if (!(Bangle.isCORESensorConnected && Bangle.isCORESensorConnected())) {
        menu["Test " + formatCoreName()] = connectToDevice;
      }
      menu["Heart Rate"] = openHeartRatePlaceholder;
    } else {
      menu["Scan for CORE"] = scanForCoreSensor;
    }
    menu["Debug"] = function () { E.showMenu(debugMenu()); };
    return menu;
  }

  readSettings();
  ensureRuntime();
  E.showMenu(buildMainMenu());
};
