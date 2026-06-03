exports.open = function (back) {
  var store = require("coretemp.store");
  var settings = {};
  var OWNER = "coretemp.settings";

  function readSettings() {
    settings = store.read();
  }

  function writeSetting(key, value) {
    store.write(function (nextSettings) {
      if (value === undefined) delete nextSettings[key];
      else nextSettings[key] = value;
    });
    readSettings();
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

  function showError(title, err, next) {
    return E.showAlert(title + "\n" + err).then(function () {
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
      "HRM: " + (status.hrm ? status.hrm.state : "") + "\n" +
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

  function describeSource(status) {
    var source = status.currentSource;
    if (!source) return status.paired ? "Paired, not connected" : "No paired HRM";
    return source.transport + "\nANT ID: " + source.antId + "\nState: " + source.stateText;
  }

  function showCurrentSource(status) {
    return E.showAlert(describeSource(status)).then(openHRMMenu);
  }

  function openPairedSensors(status) {
    var menu;
    if (!status.pairedSensors.length) {
      return E.showAlert("No paired HRM").then(openHRMMenu);
    }
    menu = {
      "": { title: "Paired Sensors" },
      "< Back": openHRMMenu
    };
    status.pairedSensors.forEach(function (entry) {
      menu["#" + (entry.index + 1) + " " + entry.antId] = function () {
        E.showAlert(
          "ANT ID: " + entry.antId + "\n" +
          "Transport: " + entry.transport + "\n" +
          "State: " + entry.stateText
        ).then(function () {
          E.showMenu(menu);
        });
      };
    });
    E.showMenu(menu);
  }

  function pairANT(id) {
    E.showMenu();
    E.showMessage("Pairing...");
    return Bangle.CORESensorHRMPairANT(id).then(openHRMMenu).catch(function (err) {
      return showError("Error pairing HRM", err, openHRMMenu);
    });
  }

  function scanANT() {
    E.showMenu();
    E.showMessage("Scanning for\n10 seconds");
    return Bangle.CORESensorHRMScanANT().then(function (found) {
      var menu;
      if (!found.length) {
        return E.showAlert("No ANT+ HRM found").then(openHRMMenu);
      }
      menu = {
        "": { title: "Scan ANT+" },
        "< Back": openHRMMenu
      };
      found.forEach(function (entry) {
        menu[entry.antId] = function () {
          E.showPrompt("Pair ANT+\n" + entry.antId + "?").then(function (confirmed) {
            if (!confirmed) return E.showMenu(menu);
            pairANT(entry.antId);
          });
        };
      });
      E.showMenu(menu);
    }).catch(function (err) {
      return showError("Error scanning HRM", err, openHRMMenu);
    });
  }

  function clearHRM() {
    E.showPrompt("Clear paired HRMs?", { title: "Clear HRMs" }).then(function (confirmed) {
      if (!confirmed) return openHRMMenu();
      E.showMenu();
      E.showMessage("Clearing...");
      Bangle.CORESensorHRMClear().then(openHRMMenu).catch(function (err) {
        showError("Error clearing HRM", err, openHRMMenu);
      });
    });
  }

  function buildHRMMenu(status) {
    var menu = {
      "": { title: "Heart Rate" },
      "< Back": function () { E.showMenu(buildMainMenu()); },
      "Current HR Source": function () { showCurrentSource(status); },
      "Scan ANT+ Sensors": scanANT,
      "Refresh": openHRMMenu
    };
    menu["Paired Sensors (" + status.pairedCount + ")"] = function () {
      openPairedSensors(status);
    };
    if (status.pairedCount) menu["Clear Paired HRMs"] = clearHRM;
    return menu;
  }

  function openHRMMenu() {
    E.showMenu();
    E.showMessage("Loading HR...");
    if (!ensureRuntime() || !Bangle.CORESensorHRMGetStatus) {
      return E.showAlert("Runtime unavailable").then(function () {
        E.showMenu(buildMainMenu());
      });
    }
    return Bangle.CORESensorHRMGetStatus().then(function (status) {
      E.showMenu(buildHRMMenu(status));
    }).catch(function (err) {
      return showError("Error loading HRM", err, buildMainMenu);
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
            E.showMessage("Pairing...");
            runWithCoreConnection(function () {
              return Bangle.CORESensorPair(device.id, device.name);
            }, true).then(function () {
              readSettings();
              return E.showAlert("Success").then(openHRMMenu);
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
      menu["Heart Rate"] = openHRMMenu;
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
