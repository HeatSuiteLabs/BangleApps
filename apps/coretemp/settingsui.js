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
      if (key === "debuglog" && value) delete nextSettings.debugpartiallog;
      if (key === "debugpartiallog" && value) delete nextSettings.debuglog;
      if (value === undefined || value === false) delete nextSettings[key];
      else nextSettings[key] = value;
    });
    readSettings();
    if (key === "enabled" && Bangle.setCORESensorPower) {
      Bangle.setCORESensorPower(!!value, BACKGROUND_OWNER);
    }
    if (key === "debuglog" && Bangle.CORESensorSetDebugLog) {
      Bangle.CORESensorSetDebugLog(!!value);
    }
    if ((key === "debuglog" || key === "debugpartiallog") && Bangle.CORESensorSetLogMode) {
      Bangle.CORESensorSetLogMode(settings.debuglog ? "full" : (settings.debugpartiallog ? "partial" : "off"));
    }
    if (key === "customprofileonly" && value && Bangle.CORESensorRebuildCache) {
      Promise.resolve(Bangle.CORESensorRebuildCache()).catch(function () {});
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

  var BLE_STEPS = ["Scanning...", "Connecting...", "Discovering...", "Attaching...", "Connected!"];
  var BLE_STATE_TO_STEP = { scanning: 0, connecting: 1, discovering: 2, attaching: 3, connected: 4 };

  function drawBleProgress(title, statusText, currentStep, errorText) {
    g.clear();
    g.setFont("6x8", 2).setFontAlign(0, -1);
    g.drawString(title, g.getWidth() / 2, 4);
    g.setFont("6x8", 1).setFontAlign(-1, -1);
    var y = 28;
    for (var i = 0; i < BLE_STEPS.length; i++) {
      var prefix;
      if (errorText && currentStep < 0) {
        prefix = (i <= BLE_STATE_TO_STEP.connecting) ? "*" : " ";
      } else if (i < currentStep) {
        prefix = "*";
      } else if (i === currentStep) {
        prefix = ">";
      } else {
        prefix = " ";
      }
      g.setColor(i < currentStep || i === currentStep ? (errorText ? "#f00" : "#0f0") : g.theme.dark ? "#666" : "#999");
      g.drawString(prefix + " " + BLE_STEPS[i], 8, y);
      y += 14;
    }
    g.setColor(-1);
    if (statusText) {
      g.setFontAlign(0, -1);
      g.drawString(statusText, g.getWidth() / 2, y + 4);
    }
    if (errorText) {
      g.setColor("#f00");
      g.setFontAlign(0, -1);
      g.drawString(errorText, g.getWidth() / 2, y + 22);
      g.setColor(-1);
    }
  }

  function showBleProgress(title, promiseFactory, backFn) {
    var statusHandler;
    var finished = false;
    var currentStep = -1;
    var statusText = "Starting...";
    var errorText = "";

    E.showMenu();
    drawBleProgress(title, statusText, currentStep, errorText);

    statusHandler = function (status) {
      if (finished) return;
      if (!status) status = {};
      var step = BLE_STATE_TO_STEP[status.state];
      if (step !== undefined && step > currentStep) {
        currentStep = step;
        statusText = "";
      }
      if (status.state === "error" || status.lastError) {
        errorText = status.lastError || "Unknown error";
        currentStep = -1;
        statusText = "Failed!";
      }
      drawBleProgress(title, statusText, currentStep, errorText);
    };

    Bangle.on("CORESensorStatus", statusHandler);

    return promiseFactory().then(function (result) {
      finished = true;
      Bangle.removeListener("CORESensorStatus", statusHandler);
      if (!errorText) {
        currentStep = BLE_STEPS.length;
        drawBleProgress(title, "Done!", currentStep, "");
      }
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(result);
        }, 800);
      });
    }).catch(function (err) {
      finished = true;
      Bangle.removeListener("CORESensorStatus", statusHandler);
      errorText = formatError(err);
      currentStep = -1;
      drawBleProgress(title, "", currentStep, errorText);
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({ _error: err, _errorText: errorText });
        }, 1500);
      });
    });
  }

  function normalizeHRMStatus(status) {
    if (!status) status = {};
    if (!status.pairedSensors) status.pairedSensors = [];
    if (!status.lastScan) status.lastScan = [];
    if (!status.recent) status.recent = [];
    if (status.pairedCount === undefined) status.pairedCount = status.pairedSensors.length;
    if (status.paired === undefined) status.paired = !!status.pairedCount;
    if (status.multiplePaired === undefined) status.multiplePaired = status.pairedCount > 1;
    if (status.currentSource === undefined) status.currentSource = status.pairedSensors[0] || null;
    if (status.syncState === undefined) status.syncState = status.paired ? "paired" : "none";
    return status;
  }

  function formatAntId(id) {
    return id !== undefined && id !== null ? String(id) : "Unknown";
  }

  function describeEntry(entry) {
    return "ANT ID: " + formatAntId(entry.antId) + "\n" +
      "Transport: " + (entry.transport || "ANT+");
  }

  function describeHRMStatus(status) {
    var lines = [];
    status = normalizeHRMStatus(status);
    lines.push("Paired: " + status.pairedCount);
    lines.push("State: " + status.syncState);
    if (status.currentSource) lines.push("ANT ID: " + formatAntId(status.currentSource.antId));
    if (status.selected) lines.push("Selected: " + formatAntId(status.selected.antId));
    if (status.lastError) lines.push("Error: " + status.lastError);
    return lines.join("\n");
  }

  function showStatus(title, text, isFlagged, next) {
    if (isFlagged) {
      return E.showAlert(title + "\n" + text).then(function () {
        return showNext(next);
      });
    }
    return E.showPrompt(text, {
      title: title,
      buttons: { "OK": true }
    }).then(function () {
      return showNext(next);
    });
  }

  function showCoreStatus() {
    var status;
    var text;
    if (!ensureRuntime() || !Bangle.CORESensorGetStatus) {
      return E.showAlert("Runtime unavailable").then(function () {
        E.showMenu(debugMenu());
      });
    }
    status = Bangle.CORESensorGetStatus();
    text = "State: " + status.state + "\n" +
      "Task: " + (status.activeTask || "") + "\n" +
      "Profile: " + (status.profile || "") + "\n" +
      "Custom only: " + status.customProfileOnly + "\n" +
      "Upgrade: " + status.profileUpgradeScheduled + "\n" +
      "HRM: " + (status.hrm ? status.hrm.operation || "" : "") + "\n" +
      "Paired: " + status.paired + "\n" +
      "Connected: " + status.connected + "\n" +
      "Error: " + (status.lastError || "");
    return showStatus("CORE status", text, status.state === "error" || !!status.lastError, debugMenu);
  }

  function rebuildCache() {
    return showBleProgress("Rebuilding Cache", function () {
      return runWithCoreConnection(function () {
        return Bangle.CORESensorRebuildCache();
      }, true);
    }).then(function (result) {
      if (result && result._error) {
        return showError("Error rebuilding cache", result._error, debugMenu);
      }
      return E.showPrompt("Cache rebuilt", {
        title: "Success",
        buttons: { "OK": true }
      }).then(function () {
        E.showMenu(debugMenu());
      });
    });
  }

  function connectToDevice() {
    return showBleProgress("Connecting to CORE", function () {
      return runWithCoreConnection(function () {
        return Promise.resolve();
      });
    }).then(function (result) {
      if (result && result._error) {
        return showError("Error during connect", result._error, buildMainMenu);
      }
      readSettings();
      E.showMenu(buildMainMenu());
    });
  }

  function formatCoreName() {
    return settings.btname || settings.btid;
  }

  function showHRMStatus() {
    E.showMenu();
    E.showMessage("Refreshing...");
    return runWithCoreConnection(function () {
      return Bangle.CORESensorHRMGetStatus();
    }).then(function (status) {
      status = normalizeHRMStatus(status);
      return showStatus("HRM status", describeHRMStatus(status), !!status.lastError || !!status.multiplePaired, openHRMMenu);
    }).catch(function (err) {
      return showError("Error loading HRM status", err, openHRMMenu);
    });
  }

  function showPairResult(status) {
    return E.showPrompt(describeHRMStatus(status), {
      title: "Success",
      buttons: { "OK": true }
    }).then(openHRMMenu);
  }

  function pairEntryWithReplace(entry, replaceExisting) {
    E.showMenu();
    E.showMessage("Pairing ANT+\n" + formatAntId(entry.antId) + "\n...");
    return runWithCoreConnection(function () {
      return Bangle.CORESensorHRMPairANT(entry, replaceExisting);
    }).then(showPairResult).catch(function (err) {
      return showError("Error pairing HRM", err, openHRMMenu);
    });
  }

  function confirmPairEntry(entry, parentMenu) {
    return runWithCoreConnection(function () {
      return Bangle.CORESensorHRMGetStatus();
    }).then(function (status) {
      status = normalizeHRMStatus(status);
      if (status.multiplePaired) {
        return E.showAlert("Multiple HRMs paired\nClear paired HRMs\nbefore pairing.").then(function () {
          if (parentMenu) E.showMenu(parentMenu);
          else openHRMMenu();
        });
      }
      if (
        status.pairedSensors.length === 1 &&
        status.pairedSensors[0].antId !== entry.antId
      ) {
        return E.showPrompt("Replace existing\nHRM?").then(function (confirmed) {
          if (!confirmed) {
            if (parentMenu) E.showMenu(parentMenu);
            else openHRMMenu();
            return;
          }
          return pairEntryWithReplace(entry, true);
        });
      }
      return E.showPrompt("Pair ANT+\n" + formatAntId(entry.antId) + "?").then(function (confirmed) {
        if (!confirmed) {
          if (parentMenu) E.showMenu(parentMenu);
          else openHRMMenu();
          return;
        }
        return pairEntryWithReplace(entry, false);
      });
    }).catch(function (err) {
      return showError("Error checking HRM", err, openHRMMenu);
    });
  }

  function openEntryMenu(entry, parentMenu) {
    E.showMenu({
      "": { title: "ANT+ " + formatAntId(entry.antId) },
      "< Back": function () { E.showMenu(parentMenu); },
      "Details": function () {
        E.showAlert(describeEntry(entry)).then(function () {
          openEntryMenu(entry, parentMenu);
        });
      },
      "Pair": function () {
        confirmPairEntry(entry, parentMenu);
      }
    });
  }

  function scanANT() {
    var menu;
    E.showMenu();
    E.showMessage("Scanning\n15s");
    return runWithCoreConnection(function () {
      return Bangle.CORESensorHRMScanANT();
    }).then(function (found) {
      if (!found.length) return E.showAlert("No ANT+ HRM found").then(openHRMMenu);
      menu = {
        "": { title: "Scan ANT+" },
        "< Back": openHRMMenu
      };
      found.forEach(function (entry) {
        menu[(entry.index + 1) + ") " + formatAntId(entry.antId)] = function () {
          openEntryMenu(entry, menu);
        };
      });
      E.showMenu(menu);
    }).catch(function (err) {
      return showError("Error scanning HRM", err, openHRMMenu);
    });
  }

  function openRecentHRMs(status) {
    var menu = {
      "": { title: "Recent HRMs" },
      "< Back": openHRMMenu
    };
    status = normalizeHRMStatus(status);
    if (!status.recent.length) return E.showAlert("No recent HRMs").then(openHRMMenu);
    status.recent.forEach(function (entry) {
      menu[formatAntId(entry.antId)] = function () {
        openEntryMenu(entry, menu);
      };
    });
    E.showMenu(menu);
  }

  function clearHRM() {
    return E.showPrompt("Clear paired HRM?").then(function (confirmed) {
      if (!confirmed) return openHRMMenu();
      E.showMenu();
      E.showMessage("Clearing...");
      return runWithCoreConnection(function () {
        return Bangle.CORESensorHRMClearANT();
      }).then(function (status) {
        return E.showPrompt("Clear complete\n" + describeHRMStatus(status), {
          title: "Success",
          buttons: { "OK": true }
        }).then(openHRMMenu);
      }).catch(function (err) {
        return showError("Error clearing HRM", err, openHRMMenu);
      });
    });
  }

  function buildHRMMenu(status) {
    status = normalizeHRMStatus(status);
    return {
      "": { title: "HRM (ANT+)" },
      "< Back": function () { E.showMenu(buildMainMenu()); },
      "Status": showHRMStatus,
      "Scan ANT+": scanANT,
      "Recent HRMs": function () { openRecentHRMs(status); },
      "Clear Paired HRM": clearHRM
    };
  }

  function openHRMMenu() {
    var state;
    if (!ensureRuntime() || !Bangle.CORESensorHRMGetStatus) {
      return E.showAlert("Runtime unavailable").then(function () {
        E.showMenu(buildMainMenu());
      });
    }
    state = Bangle.CORESensorHRMGetState ? Bangle.CORESensorHRMGetState() : {};
    E.showMenu(buildHRMMenu(state));
  }

  function debugMenu() {
    return {
      "": { title: "Debug" },
      "< Back": function () { E.showMenu(buildMainMenu()); },
      "Alert on disconnect": {
        value: !!settings.warnDisconnect,
        onchange: function (v) { writeSetting("warnDisconnect", v); }
      },
      "Full log": {
        value: !!settings.debuglog,
        onchange: function (v) {
          writeSetting("debuglog", v);
          E.showMenu(debugMenu());
        }
      },
      "Partial log": {
        value: !!settings.debugpartiallog,
        onchange: function (v) {
          writeSetting("debugpartiallog", v);
          E.showMenu(debugMenu());
        }
      },
      "Custom CORE only": {
        value: !!settings.customprofileonly,
        onchange: function (v) { writeSetting("customprofileonly", v); }
      },
      "Status": showCoreStatus,
      "Rebuild cache": rebuildCache,
      "Reset All": function () {
        E.showPrompt("Clear all CORE data?\nThis includes pairing,\ncache, settings, logs.", {
          title: "Reset CORE"
        }).then(function (confirmed) {
          if (!confirmed) return E.showMenu(debugMenu());
          try {
            if (Bangle.setCORESensorPower) Bangle.setCORESensorPower(0, OWNER);
            if (Bangle.CORESensorUnpair) Bangle.CORESensorUnpair();
          } catch (e) {}
          try { require("Storage").open("coretemp.log", "r").erase(); } catch (e) {}
          try { require("Storage").open("coretemp.hrm.json", "r").erase(); } catch (e) {}
          require("Storage").writeJSON("coretemp.json", { enabled: false, widget: true });
          require("Storage").compact();
          readSettings();
          E.showPrompt("CORE reset complete.", {
            title: "Reset",
            buttons: { "OK": true }
          }).then(function () {
            E.showMenu(buildMainMenu());
          });
        });
      }
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
            showBleProgress("Pairing with\n" + shown, function () {
              return runWithCoreConnection(function () {
                return Bangle.CORESensorPair(device).then(function (result) {
                  readSettings();
                  if (settings.enabled && Bangle.setCORESensorPower) {
                    Bangle.setCORESensorPower(1, BACKGROUND_OWNER);
                  }
                  return result;
                });
              }, true);
            }).then(function (pairResult) {
              if (pairResult && pairResult._error) {
                return showError("Error during pairing", pairResult._error, buildMainMenu);
              }
              readSettings();
              return E.showPrompt("CORE paired", {
                title: "Success",
                buttons: { "OK": true }
              }).then(function () {
                E.showMenu(buildMainMenu());
              });
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
      "Always On": {
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
      menu["HRM (ANT+)"] = openHRMMenu;
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
