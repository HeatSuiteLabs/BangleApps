// This file should contain exactly one function, which shows the app's settings
/**
 * @param {function} back Use back() to return to settings menu
 */
(function (back) {
  var settings = {};
  var SETTINGS_FILE = "coretemp.json";
  var CORE_RUNTIME_OWNER = "coretemp.settings";

  function log() {
    if (!settings.debuglog) return;
    print.apply(null, arguments);
  }

  function readSettings() {
    settings = Object.assign(
      require("Storage").readJSON(SETTINGS_FILE, true) || {}
    );
  }

  function writeSettings(key, value) {
    var nextSettings = require("Storage").readJSON(SETTINGS_FILE, true) || {};
    if (value === undefined) delete nextSettings[key];
    else nextSettings[key] = value;
    require("Storage").writeJSON(SETTINGS_FILE, nextSettings);
    readSettings();
  }

  function ensureRuntime() {
    if (!Bangle.CORESensorPair) {
      try {
        require("CORESensor").enable();
      } catch (e) {
        log("Unable to load CORESensor runtime", e);
      }
    }
    return !!Bangle.CORESensorPair;
  }

  function delayPromise(timeout) {
    return new Promise(function (resolve) {
      setTimeout(resolve, timeout);
    });
  }

  function runWithCoreConnection(fn, options) {
    options = options || {};
    if (!ensureRuntime()) {
      return Promise.reject(new Error("CORESensor runtime is unavailable"));
    }

    var acquiredPower = false;
    if (Bangle.setCORESensorPower && Bangle.isCORESensorOn && !Bangle.isCORESensorOn()) {
      Bangle.setCORESensorPower(1, CORE_RUNTIME_OWNER);
      acquiredPower = true;
    }

    var promise = Promise.resolve();
    if (!options.skipConnect) {
      if (!Bangle.CORESensorConnect) {
        return Promise.reject(new Error("CORESensor runtime is unavailable"));
      }
      promise = promise.then(function () {
        return Bangle.CORESensorConnect();
      });
    }

    promise = promise.then(function () {
      return fn();
    });

    return promise.then(function (result) {
      if (acquiredPower && Bangle.setCORESensorPower) {
        Bangle.setCORESensorPower(0, CORE_RUNTIME_OWNER);
      }
      return result;
    }, function (err) {
      if (acquiredPower && Bangle.setCORESensorPower) {
        Bangle.setCORESensorPower(0, CORE_RUNTIME_OWNER);
      }
      throw err;
    });
  }

  function showErrorAndMenu(title, err, menuBuilder) {
    log(title, err);
    return E.showAlert(title + "\n" + err).then(function () {
      E.showMenu(menuBuilder());
    });
  }

  function writeToControlPoint(opCode, params) {
    params = params || [];
    if (!ensureRuntime() || !Bangle.CORESensorWriteControlPoint) {
      return Promise.reject(new Error("CORESensor runtime is unavailable"));
    }
    return Bangle.CORESensorWriteControlPoint(opCode, params);
  }

  function parseAntStatus(response) {
    var byte1 = response[3] || 0;
    var byte2 = response[4] || 0;
    var txType = response[5] || 0;
    var hrmState = response[6] || 0;
    return {
      antId: byte1 | (byte2 << 8) | (txType << 16),
      txType: txType,
      state: hrmState,
      stateText: ["Closed", "Searching", "Synchronized", "Reserved"][hrmState & 0x03]
    };
  }

  function clearPairedHRM_ANT() {
    return writeToControlPoint(0x01).then(function (response) {
      if (response[2] === 0x01) return;
      throw new Error("Error code: " + response[2]);
    });
  }

  function scanUntilSynchronized(maxRetries, delayMs) {
    var attempts = 0;

    function checkStatus() {
      return writeToControlPoint(0x05, [0]).then(function (response) {
        var status = parseAntStatus(response);
        log("HRM status", status);
        if (status.stateText === "Synchronized") {
          status.maxReached = false;
          return status;
        }
        attempts++;
        if (attempts >= maxRetries) {
          status.maxReached = true;
          return status;
        }
        return writeToControlPoint(0x0D)
          .then(function () {
            return writeToControlPoint(0x0A, [0xFF]);
          })
          .then(function () {
            return delayPromise(delayMs);
          })
          .then(checkStatus);
      });
    }

    return writeToControlPoint(0x0A, [0xFF])
      .then(function () {
        return delayPromise(delayMs);
      })
      .then(checkStatus);
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
      return showErrorAndMenu("Error during connect", err, buildMainMenu);
    });
  }

  function showHRMStatus() {
    E.showMenu();
    E.showMessage("Checking HRM...");
    return runWithCoreConnection(function () {
      return scanUntilSynchronized(10, 3000);
    }).then(function (status) {
      var message = "HRM Status\nANT ID = " + status.antId + "\nState = " + status.stateText;
      if (status.maxReached) message += "\nMax retries reached";
      return E.showAlert(message).then(function () {
        E.showMenu(HRM_MENU());
      });
    }).catch(function (err) {
      return showErrorAndMenu("Error checking HRM", err, HRM_MENU);
    });
  }

  function pairFoundHRM(id) {
    var byte1 = id & 0xFF;
    var byte2 = (id >> 8) & 0xFF;
    var byte3 = (id >> 16) & 0xFF;
    E.showMenu();
    E.showMessage("Connecting...");
    return runWithCoreConnection(function () {
      return clearPairedHRM_ANT()
        .then(function () {
          return writeToControlPoint(0x02, [byte1, byte2, byte3]);
        });
    }).then(function () {
      writeSettings("ANT_HRM", { antId: id });
      E.showMenu(HRM_MENU());
    }).catch(function (err) {
      return showErrorAndMenu("Error pairing HRM", err, HRM_MENU);
    });
  }

  function scanHRM_ANT() {
    E.showMenu();
    E.showMessage("Scanning for 10 seconds");
    return runWithCoreConnection(function () {
      return writeToControlPoint(0x0A, [0xFF])
        .then(function () {
          return delayPromise(10000);
        })
        .then(function () {
          return writeToControlPoint(0x0B);
        })
        .then(function (response) {
          var count = response[3] || 0;
          var found = [];
          var requests = [];
          for (var i = 0; i < count; i++) {
            (function (index) {
              requests.push(
                writeToControlPoint(0x0C, [index]).then(function (hrmResponse) {
                  var status = parseAntStatus(hrmResponse);
                  found.push({ antId: status.antId });
                })
              );
            })(i);
          }
          return Promise.all(requests).then(function () {
            return found;
          });
        });
    }).then(function (hrmFound) {
      if (!hrmFound.length) {
        return E.showAlert("No ANT+ HRM found.").then(function () {
          E.showMenu(HRM_MENU());
        });
      }
      var submenuScan = {
        "": { title: "ANT+ Scan" },
        "< Back": function () { E.showMenu(HRM_MENU()); }
      };
      hrmFound.forEach(function (hrm) {
        submenuScan[hrm.antId] = function () {
          E.showPrompt("Connect to\n" + hrm.antId + "?", { title: "ANT+ Pairing" }).then(function (confirmed) {
            if (!confirmed) {
              E.showMenu(HRM_MENU());
              return;
            }
            pairFoundHRM(hrm.antId);
          });
        };
      });
      E.showMenu(submenuScan);
    }).catch(function (err) {
      return showErrorAndMenu("Error scanning HRM", err, HRM_MENU);
    });
  }

  function rebuildCache() {
    E.showMenu();
    E.showMessage("Rebuilding...");
    return runWithCoreConnection(function () {
      return Bangle.CORESensorRebuildCache();
    }, { skipConnect: true }).then(function () {
      return E.showAlert("Cache rebuilt").then(function () {
        E.showMenu(submenu_debug);
      });
    }).catch(function (err) {
      return showErrorAndMenu("Error rebuilding cache", err, function () {
        return submenu_debug;
      });
    });
  }

  function showStatus() {
    if (!ensureRuntime() || !Bangle.CORESensorGetStatus) {
      return E.showAlert("Runtime unavailable").then(function () {
        E.showMenu(submenu_debug);
      });
    }
    var status = Bangle.CORESensorGetStatus();
    return E.showAlert(
      "State: " + status.state + "\n" +
      "Paired: " + status.paired + "\n" +
      "Connected: " + status.connected + "\n" +
      "Reconnect: " + status.reconnectScheduled + "\n" +
      "Cache: " + status.hasCache + "\n" +
      "Error: " + (status.lastError || "")
    ).then(function () {
      E.showMenu(submenu_debug);
    });
  }

  function buildMainMenu() {
    var mainmenu = {
      "": { title: "CORE Sensor" },
      "< Back": back,
      "Enable": {
        value: !!settings.enabled,
        onchange: function (v) {
          writeSettings("enabled", v);
        }
      },
      "Widget": {
        value: !!settings.widget,
        onchange: function (v) {
          writeSettings("widget", v);
        }
      }
    };

    if (settings.btname || settings.btid) {
      var name = "Unpair " + (settings.btname || settings.btid);
      mainmenu[name] = function () {
        E.showPrompt("Unpair current device?").then(function (confirmed) {
          if (!confirmed) {
            E.showMenu(buildMainMenu());
            return;
          }
          if (ensureRuntime() && Bangle.CORESensorUnpair) {
            Promise.resolve(Bangle.CORESensorUnpair()).then(function () {
              readSettings();
              E.showMenu(buildMainMenu());
            }).catch(function (err) {
              showErrorAndMenu("Error during unpair", err, buildMainMenu);
            });
            return;
          }
          writeSettings("btname", undefined);
          writeSettings("btid", undefined);
          writeSettings("cache", undefined);
          E.showMenu(buildMainMenu());
        });
      };

      if (!(Bangle.isCORESensorConnected && Bangle.isCORESensorConnected())) {
        var connect = "Connect " + (settings.btname || settings.btid);
        mainmenu[connect] = function () {
          connectToDevice();
        };
      }
      mainmenu["HRM Settings"] = function () {
        E.showMenu(HRM_MENU());
      };
    } else {
      mainmenu["Scan for CORE"] = function () {
        ScanForCORESensor();
      };
    }

    mainmenu["Debug"] = function () {
      E.showMenu(submenu_debug);
    };
    return mainmenu;
  }

  var submenu_debug = {
    "": { title: "Debug" },
    "< Back": function () { E.showMenu(buildMainMenu()); },
    "Alert on disconnect": {
      value: !!settings.warnDisconnect,
      onchange: function (v) {
        writeSettings("warnDisconnect", v);
      }
    },
    "Debug log": {
      value: !!settings.debuglog,
      onchange: function (v) {
        writeSettings("debuglog", v);
      }
    },
    "Status": function () {
      showStatus();
    },
    "Rebuild cache": function () {
      rebuildCache();
    }
  };

  function HRM_MENU() {
    var menu = {
      "": { title: "CORE: HR" },
      "< Back": function () { E.showMenu(buildMainMenu()); },
      "Scan for ANT+": function () { scanHRM_ANT(); }
    };

    if (settings.btid || settings.btname) {
      menu["ANT+ Status"] = function () {
        showHRMStatus();
      };
      menu["Clear ANT+"] = function () {
        E.showPrompt("Clear ANT+ HRs?", { title: "Clear ANT+" }).then(function (confirmed) {
          if (!confirmed) {
            E.showMenu(HRM_MENU());
            return;
          }
          E.showMenu();
          E.showMessage("Clearing...");
          runWithCoreConnection(function () {
            return clearPairedHRM_ANT();
          }).then(function () {
            E.showMenu(HRM_MENU());
          }).catch(function (err) {
            showErrorAndMenu("Error clearing ANT+", err, HRM_MENU);
          });
        });
      };
    }
    return menu;
  }

  function ScanForCORESensor() {
    E.showMenu();
    E.showMessage("Scanning for 5 seconds");
    var submenuScan = {
      "< Back": function () { E.showMenu(buildMainMenu()); }
    };

    NRF.findDevices(function (devices) {
      submenuScan[""] = { title: "Scan (" + devices.length + " found)" };
      if (!devices.length) {
        E.showAlert("No devices found").then(function () {
          E.showMenu(buildMainMenu());
        });
        return;
      }

      devices.forEach(function (device) {
        var shown = device.name || device.id.substr(0, 17);
        submenuScan[shown] = function () {
          E.showPrompt("Connect to\n" + shown + "?", { title: "Pairing" }).then(function (confirmed) {
            if (!confirmed) return;
            E.showMenu();
            E.showMessage("Pairing...");
            runWithCoreConnection(function () {
              return Bangle.CORESensorPair(device.id, device.name);
            }, { skipConnect: true }).then(function () {
              writeSettings("btid", device.id);
              if (device.name) writeSettings("btname", device.name);
              return E.showPrompt("Success!", {
                buttons: { "OK": true }
              }).then(function () {
                readSettings();
                E.showMenu(HRM_MENU());
              });
            }).catch(function (err) {
              showErrorAndMenu("Error during pairing", err, buildMainMenu);
            });
          });
        };
      });

      E.showMenu(submenuScan);
    }, {
      timeout: 5000,
      active: true,
      filters: [{ services: ["00002100-5b1e-4347-b07c-97b514dae121"] }]
    });
  }

  function init() {
    readSettings();
    ensureRuntime();
    E.showMenu();
    E.showMenu(buildMainMenu());
  }

  readSettings();
  init();
});
