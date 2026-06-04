exports.open = function (back) {
  var store = require("coretemp.store");
  var settings = {};
  var OWNER = "coretemp.settings";
  var BACKGROUND_OWNER = "coretemp.enabled";
  var hrmMenuRefreshToken = 0;

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

  function normalizeHRMStatus(status) {
    if (!status) status = {};
    if (!status.pairedSensors) status.pairedSensors = [];
    if (status.pairedCount === undefined) status.pairedCount = status.pairedSensors.length;
    if (status.pairedCountKnown === undefined) status.pairedCountKnown = true;
    if (status.paired === undefined) status.paired = !!status.pairedCount;
    if (status.multiplePaired === undefined) status.multiplePaired = status.pairedCount > 1;
    if (status.currentSource === undefined) status.currentSource = null;
    if (status.activeSource === undefined) status.activeSource = null;
    if (status.syncState === undefined) {
      status.syncState = status.paired ? "paired" : "none";
    }
    return status;
  }

  function formatAntId(id) {
    return id !== undefined ? String(id) : "Unknown";
  }

  function describeConfiguredHRM(status) {
    var lines = [];
    lines.push("Transport: " + (status.configuredTransport || "ANT+"));
    lines.push("ANT ID: " + formatAntId(status.configuredAntId));
    lines.push("Valid: " + (status.configuredValid ? "Yes" : "No"));
    lines.push("Last Sent: " + (status.lastSent ? "Yes" : "No"));
    if (status.lastError) lines.push("Error: " + status.lastError);
    return lines.join("\n");
  }

  function showConfiguredHRM(status) {
    if (!status) return E.showAlert("No status available").then(openHRMMenu);
    return E.showAlert(describeConfiguredHRM(status)).then(openHRMMenu);
  }

  function invalidateHRMMenuRefresh() {
    hrmMenuRefreshToken++;
  }

  function describeStatus(status) {
    var lines = [];
    status = normalizeHRMStatus(status);
    lines.push("Paired: " + (status.pairedCountKnown ? status.pairedCount : "?"));
    lines.push("State: " + status.syncState);
    if (status.currentSource) {
      lines.push("ANT ID: " + formatAntId(status.currentSource.antId));
      lines.push("Source: " + status.currentSource.stateText);
    }
    if (status.lastError) lines.push("Error: " + status.lastError);
    return lines.join("\n");
  }

  function showStatus(title, status) {
    return E.showAlert(title + "\n" + describeStatus(status)).then(openHRMMenu);
  }

  function showSuccessStatus(title, status) {
    return E.showPrompt(title + "\n" + describeStatus(status), {
      title: "Success",
      buttons: { "OK": true }
    }).then(openHRMMenu);
  }

  function returnToHRMMenu(status) {
    E.showMenu(buildHRMMenu(normalizeHRMStatus(status)));
  }

  function isHRMStatus(value) {
    return !!(value && typeof value === "object" &&
      (value.pairedSensors || value.pairedCount !== undefined || value.managerState));
  }

  function describeEntry(entry) {
    var lines = [];
    lines.push("ANT ID: " + formatAntId(entry.antId));
    lines.push("Transport: " + (entry.transport || "ANT+"));
    lines.push("State: " + (entry.stateText || "Unknown"));
    if (entry.entryReadable === false) lines.push("Readback: unavailable");
    if (entry.lastEntryError) lines.push("Error: " + entry.lastEntryError);
    lines.push("Individual remove\nis unsupported.");
    lines.push("Use Unpair All.");
    return lines.join("\n");
  }

  function openPairedSensor(entry, parentMenu) {
    var title = "HRM " + (entry.index + 1);
    E.showMenu({
      "": { title: title },
      "< Back": function () { E.showMenu(parentMenu); },
      "Details": function () {
        E.showAlert(describeEntry(entry)).then(function () {
          openPairedSensor(entry, parentMenu);
        });
      },
      "Remove This": function () {
        E.showAlert("Individual remove\nis not available\nwith known CORE\nANT+ opcodes.").then(function () {
          openPairedSensor(entry, parentMenu);
        });
      },
      "Unpair All": clearHRM
    });
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
      menu["#" + (entry.index + 1) + " " + formatAntId(entry.antId)] = function () {
        openPairedSensor(entry, menu);
      };
    });
    E.showMenu(menu);
  }

  function sendConfiguredHRM() {
    invalidateHRMMenuRefresh();
    E.showMenu();
    E.showMessage("Sending\npreset...");
    return Bangle.CORESensorHRMSendPreset().then(function (status) {
      return showStatus("Preset sent", status);
    }).catch(function (err) {
      return showError("Error sending preset", err, openHRMMenu);
    });
  }

  function pairANT(id) {
    invalidateHRMMenuRefresh();
    E.showMenu();
    E.showMessage("Pairing with\n" + id + "\n...");
    return Bangle.CORESensorHRMPairANT(id).then(function (status) {
      return showStatus("Pair complete", status);
    }).catch(function (err) {
      return showError("Error pairing HRM", err, openHRMMenu);
    });
  }

  function openScannedSensor(entry, parentMenu) {
    E.showMenu({
      "": { title: "ANT+ " + entry.antId },
      "< Back": function () { E.showMenu(parentMenu); },
      "Details": function () {
        E.showAlert(
          "ANT ID: " + entry.antId + "\n" +
          "State: " + entry.stateText + "\n" +
          "Transport: " + entry.transport
        ).then(function () {
          openScannedSensor(entry, parentMenu);
        });
      },
      "Pair": function () {
        E.showPrompt("Pair ANT+\n" + entry.antId + "?").then(function (confirmed) {
          if (!confirmed) return openScannedSensor(entry, parentMenu);
          pairANT(entry.antId);
        });
      }
    });
  }

  function scanANT() {
    invalidateHRMMenuRefresh();
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
          openScannedSensor(entry, menu);
        };
      });
      E.showMenu(menu);
    }).catch(function (err) {
      return showError("Error scanning HRM", err, openHRMMenu);
    });
  }

  function clearHRM() {
    invalidateHRMMenuRefresh();
    E.showPrompt("Unpair all HRMs?", { title: "Unpair All" }).then(function (confirmed) {
      if (!confirmed) return openHRMMenu();
      E.showMenu();
      E.showMessage("Unpairing...");
      Bangle.CORESensorHRMClear().then(function (status) {
        return showSuccessStatus("Unpair complete", status);
      }).catch(function (err) {
        showError("Error unpairing HRM", err, openHRMMenu);
      });
    });
  }

  function showFreshHRMStatus() {
    invalidateHRMMenuRefresh();
    E.showMenu();
    E.showMessage("Refreshing...");
    return Bangle.CORESensorHRMGetStatus().then(function (status) {
      status = normalizeHRMStatus(status);
      return E.showAlert("HRM status\n" + describeStatus(status)).then(function () {
        returnToHRMMenu(status);
      });
    }, function (err) {
      if (isHRMStatus(err)) {
        err = normalizeHRMStatus(err);
        return E.showAlert("HRM status\n" + describeStatus(err)).then(function () {
          returnToHRMMenu(err);
        });
      }
      return showError("Error loading HRM status", err, openHRMMenu);
    });
  }

  function buildHRMMenu(status) {
    var pairedLabel;
    var menu;

    status = normalizeHRMStatus(status);
    pairedLabel = status.pairedCountKnown ? String(status.pairedCount) : "?";

    menu = {
      "": { title: "HRM ANT+" },
      "< Back": function () { E.showMenu(buildMainMenu()); },
      "Status": showFreshHRMStatus,
      "Preset": function () { showConfiguredHRM(status); },
      "Send Preset": sendConfiguredHRM,
      "Scan ANT+": scanANT,
      "Unpair All": clearHRM
    };
    menu["Paired Devices (" + pairedLabel + ")"] = function () {
      openPairedSensors(status);
    };
    if (status.lastError) {
      menu["Last HRM Error"] = function () {
        E.showAlert(status.lastError).then(openHRMMenu);
      };
    }
    return menu;
  }

  function openHRMMenu() {
    var cachedStatus;
    var managerState;
    var refreshToken;

    if (!ensureRuntime() || !Bangle.CORESensorHRMGetStatus) {
      return E.showAlert("Runtime unavailable").then(function () {
        E.showMenu(buildMainMenu());
      });
    }

    refreshToken = ++hrmMenuRefreshToken;
    managerState = (
      Bangle.CORESensorHRMGetManagerState &&
      Bangle.CORESensorHRMGetManagerState()
    ) || {};
    cachedStatus = (
      managerState.lastStatus
    ) || {
      pairedCountKnown: false,
      pairedSensors: [],
      pairedCount: 0,
      paired: false,
      currentSource: null,
      activeSource: null,
      syncState: "unknown"
    };

    E.showMenu(buildHRMMenu(normalizeHRMStatus(cachedStatus)));

    if (managerState.busy) return;

    Bangle.CORESensorHRMGetStatus().then(function (status) {
      if (refreshToken !== hrmMenuRefreshToken) return;
      E.showMenu(buildHRMMenu(normalizeHRMStatus(status)));
    }, function (err) {
      if (refreshToken !== hrmMenuRefreshToken) return;
      if (isHRMStatus(err)) {
        E.showMenu(buildHRMMenu(normalizeHRMStatus(err)));
        return;
      }
      store.log("HRM status refresh failed", err);
      E.showMenu(buildHRMMenu(normalizeHRMStatus({
        pairedCountKnown: false,
        pairedSensors: [],
        pairedCount: 0,
        paired: false,
        currentSource: null,
        activeSource: null,
        syncState: "unknown",
        lastError: formatError(err)
      })));
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
