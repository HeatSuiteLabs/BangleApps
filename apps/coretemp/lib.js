exports.enable = function () {
  var settings = require("Storage").readJSON("coretemp.json", 1) || {};
  var log = function () { };
  var logBuffer = [];
  var logFlushInterval;
  var LOG_MAX_LINES = 200;
  var CORE_SERVICE_UUID = "00002100-5b1e-4347-b07c-97b514dae121";
  var CORE_TEMP_UUID = "00002101-5b1e-4347-b07c-97b514dae121";
  var CORE_CONTROL_POINT_UUID = "00002102-5b1e-4347-b07c-97b514dae121";
  var CORE_STATE = {
    IDLE: "idle",
    SCANNING: "scanning",
    CONNECTING: "connecting",
    DISCOVERING: "discovering",
    ATTACHING: "attaching",
    CONNECTED: "connected",
    RECONNECT_WAIT: "reconnect_wait",
    DISCONNECTING: "disconnecting",
    ERROR: "error"
  };
  var RECONNECT_DELAY_MIN_MS = 5000;
  var RECONNECT_DELAY_MAX_MS = 30000;
  var BLE_SETTLE_DELAY_MS = 2000;
  var BLE_BUSY_RETRY_LIMIT = 3;

  var gatt;
  var device;
  var characteristics = [];
  var controlPointChar;
  var controlPointQueue = Promise.resolve();
  var activeControlPointRequest;
  var reconnectTimer;
  var reconnectDelayMs = RECONNECT_DELAY_MIN_MS;
  var expectedDisconnectDevice;
  var lastReceivedData = {};
  var coreState = CORE_STATE.IDLE;
  var lastError;

  // One serialized lifecycle queue owns request/connect/bond/discover/disconnect.
  var lifecycleQueue = Promise.resolve();
  var activeLifecycleTask;
  var shouldBeConnected = false;
  var pendingReconnect = false;
  var pendingRebuildCache = false;
  var pendingPairTarget;
  var pendingUnpair = false;
  var pendingDisconnect = false;

  function flushLog() {
    if (logBuffer.length === 0) return;
    while (logBuffer.length > LOG_MAX_LINES) logBuffer.shift();
    var lines = logBuffer.join("\n") + "\n";
    try {
      var f = require("Storage").open("coretemp.log", "a");
      f.write(lines);
    } catch (e) {
      // ignore storage write failures
    }
    logBuffer = [];
  }

  Bangle.disableCORESensorLog = function () {
    flushLog();
    log = function () { };
    if (logFlushInterval) {
      clearInterval(logFlushInterval);
      logFlushInterval = undefined;
    }
  };

  Bangle.enableCORESensorLog = function () {
    log = function (text, param) {
      var logline = new Date().toISOString() + " - " + text;
      if (param !== undefined) logline += ": " + JSON.stringify(param);
      print(logline);
      logBuffer.push(logline);
    };
    if (!logFlushInterval) logFlushInterval = setInterval(flushLog, 30000);
  };

  Bangle.CORESensorSetDebugLog = function (enabled) {
    if (enabled) Bangle.enableCORESensorLog();
    else Bangle.disableCORESensorLog();
  };

  Bangle.CORESensorSetDebugLog(!!settings.debuglog);

  function readCoreSettings() {
    settings = require("Storage").readJSON("coretemp.json", 1) || {};
    return settings;
  }

  function writeCoreSettings(mutator) {
    var nextSettings = require("Storage").readJSON("coretemp.json", 1) || {};
    mutator(nextSettings);
    require("Storage").writeJSON("coretemp.json", nextSettings);
    settings = nextSettings;
    return nextSettings;
  }

  function setCoreState(nextState, reason) {
    coreState = nextState;
    if (reason !== undefined) log("CORE state -> " + nextState, reason);
    else log("CORE state -> " + nextState);
  }

  function waitingPromise(timeout) {
    return new Promise(function (resolve) {
      log("Start waiting for " + timeout);
      setTimeout(function () {
        log("Done waiting for " + timeout);
        resolve();
      }, timeout);
    });
  }

  function waitForBleSettle(reason) {
    log("Waiting for BLE settle", reason);
    return waitingPromise(BLE_SETTLE_DELAY_MS);
  }

  function resetReconnectBackoff() {
    reconnectDelayMs = RECONNECT_DELAY_MIN_MS;
  }

  function increaseReconnectBackoff() {
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (!shouldBeConnected) setCoreState(CORE_STATE.IDLE, "reconnect cancelled");
  }

  function dataViewToArray(dv) {
    var response = [];
    for (var i = 0; i < dv.byteLength; i++) response.push(dv.getUint8(i));
    return response;
  }

  function ensureBonded(currentGatt) {
    // Pairing/cache state lives in storage, but bonding lives in the BLE stack.
    // Re-establish bonding here before cached handles or notifications are used.
    if (!currentGatt || !currentGatt.getSecurityStatus) return Promise.resolve();
    var status;
    try {
      status = currentGatt.getSecurityStatus();
    } catch (e) {
      log("Unable to read CORE security status", e);
      return Promise.resolve();
    }
    log("CORE security status", status);
    if (status && status.bonded) return Promise.resolve();
    if (!currentGatt.startBonding) return Promise.resolve();
    log("Starting CORE bonding");
    return currentGatt.startBonding().then(function () {
      try {
        log("CORE bonded", currentGatt.getSecurityStatus());
      } catch (e) {
        log("CORE bonded");
      }
    });
  }

  function isBleTransportError(err) {
    var msg = String(err);
    return msg.indexOf("GATT") >= 0 ||
      msg.indexOf("Disconnected") >= 0 ||
      msg.indexOf("disconnected") >= 0 ||
      msg.indexOf("not connected") >= 0;
  }

  function isBleBusyError(err) {
    return String(err).indexOf("already in progress") >= 0;
  }

  function rejectActiveControlPoint(err) {
    if (!activeControlPointRequest) return;
    var request = activeControlPointRequest;
    activeControlPointRequest = undefined;
    if (request.timeout) clearTimeout(request.timeout);
    request.reject(err);
  }

  function handleControlPointResponse(dv) {
    if (!activeControlPointRequest || dv.byteLength < 3) return;
    var requestOpCode = dv.getUint8(1);
    if (requestOpCode !== activeControlPointRequest.opCode) return;
    var resultCode = dv.getUint8(2);
    var request = activeControlPointRequest;
    activeControlPointRequest = undefined;
    if (request.timeout) clearTimeout(request.timeout);
    if (resultCode === 0x01) request.resolve(dataViewToArray(dv));
    else request.reject(new Error("Control point error code: " + resultCode));
  }

  var supportedCharacteristics = {
    "00002101-5b1e-4347-b07c-97b514dae121": {
      handler: function (dv) {
        log(dv);
        var index = 0;
        var flags = dv.getUint8(index++);
        var coreTemp = dv.getInt16(index, true) / 100.0;
        index += 2;
        var skinTemp = dv.getInt16(index, true) / 100.0;
        index += 2;
        var coreReserved = dv.getInt16(index, true);
        index += 2;
        var qualityAndState = dv.getUint8(index++);
        var heartRate = dv.getUint8(index++);
        var heatStrainIndex = dv.getUint8(index) / 10.0;
        var dataQuality = qualityAndState & 0x07;
        var hrState = (qualityAndState >> 4) & 0x03;
        var data = {
          core: coreTemp,
          skin: skinTemp,
          unit: (flags & 0b00001000) ? "F" : "C",
          hr: heartRate,
          heatflux: coreReserved,
          hsi: heatStrainIndex,
          battery: 0,
          dataQuality: dataQuality,
          hrState: hrState
        };
        if (lastReceivedData.hasOwnProperty("0x180f")) {
          data.battery = lastReceivedData["0x180f"]["0x2a19"];
        }
        log("data", data);
        Bangle.emit("CORESensor", data);
      }
    },
    "00002102-5b1e-4347-b07c-97b514dae121": {
      handler: function (dv) {
        log("Control point response", dataViewToArray(dv));
        handleControlPointResponse(dv);
      }
    },
    "0x2a19": {
      handler: function (dv) {
        if (!lastReceivedData["0x180f"]) lastReceivedData["0x180f"] = {};
        log("Got battery", dv);
        lastReceivedData["0x180f"]["0x2a19"] = dv.getUint8(0);
      }
    }
  };

  var supportedServices = [
    CORE_SERVICE_UUID,
    "0x180f",
    "0x1809"
  ];

  var supportedCharacteristicUUIDs = [
    CORE_TEMP_UUID,
    CORE_CONTROL_POINT_UUID,
    "0x2a19"
  ];

  Bangle.isCORESensorOn = function () {
    return !!(Bangle._PWR && Bangle._PWR.CORESensor && Bangle._PWR.CORESensor.length > 0);
  };

  Bangle.isCORESensorConnected = function () {
    return !!(gatt && gatt.connected);
  };

  function addNotificationHandler(characteristic) {
    if (!supportedCharacteristics[characteristic.uuid]) return;
    if (characteristic._coretempHandlerAdded) return;
    characteristic._coretempHandlerAdded = true;
    characteristic.on("characteristicvaluechanged", function (ev) {
      supportedCharacteristics[characteristic.uuid].handler(ev.target.value);
    });
  }

  function characteristicsFromCache(currentDevice) {
    var service = { device: currentDevice };
    var cache = settings.cache;
    if (!cache || !cache.characteristics) return [];
    log("Read cached characteristics");
    var restored = [];
    for (var uuid in cache.characteristics) {
      if (!cache.characteristics.hasOwnProperty(uuid)) continue;
      var cached = cache.characteristics[uuid];
      var characteristic = new BluetoothRemoteGATTCharacteristic();
      log("Restoring characteristic", cached);
      characteristic.handle_value = cached.handle;
      characteristic.uuid = cached.uuid;
      characteristic.properties = {};
      characteristic.properties.notify = cached.notify;
      characteristic.properties.read = cached.read;
      characteristic.properties.write = cached.write;
      characteristic.service = service;
      addNotificationHandler(characteristic);
      restored.push(characteristic);
    }
    return restored;
  }

  function saveCache(chars) {
    writeCoreSettings(function (nextSettings) {
      var cache = { characteristics: {} };
      chars.forEach(function (characteristic) {
        cache.characteristics[characteristic.uuid] = {
          handle: characteristic.handle_value,
          uuid: characteristic.uuid,
          notify: characteristic.properties.notify,
          read: characteristic.properties.read,
          write: characteristic.properties.write
        };
      });
      nextSettings.cache = cache;
    });
  }

  function deleteCache() {
    writeCoreSettings(function (nextSettings) {
      delete nextSettings.cache;
    });
  }

  function hasRequiredCoreCharacteristics(chars) {
    var uuids = chars.map(function (characteristic) {
      return characteristic.uuid;
    });
    return uuids.indexOf(CORE_TEMP_UUID) >= 0 &&
      uuids.indexOf(CORE_CONTROL_POINT_UUID) >= 0;
  }

  function isTransportReady() {
    return !!(gatt && gatt.connected && controlPointChar && hasRequiredCoreCharacteristics(characteristics));
  }

  function createCharacteristicPromise(characteristic) {
    if (characteristic.uuid === CORE_CONTROL_POINT_UUID) controlPointChar = characteristic;
    var result = Promise.resolve();
    if (characteristic.properties && characteristic.properties.read) {
      result = result.then(function () {
        log("Reading data", characteristic.uuid);
        return characteristic.readValue().then(function (data) {
          if (supportedCharacteristics[characteristic.uuid] &&
            supportedCharacteristics[characteristic.uuid].handler) {
            supportedCharacteristics[characteristic.uuid].handler(data);
          }
        });
      });
    }
    if (characteristic.properties && characteristic.properties.notify) {
      result = result.then(function () {
        // CORE's control-point channel requires an explicit enable write
        // before ANT+ indication responses are delivered.
        if (characteristic.uuid === CORE_CONTROL_POINT_UUID) {
          return characteristic.writeValue(new Uint8Array([0x02]), {
            type: "command",
            handle: true
          }).then(function () {
            log("Control point indications enabled");
          });
        }
      }).then(function () {
        log("Starting notifications", characteristic.uuid);
        return characteristic.startNotifications()
          .then(function () {
            log("Notifications started", characteristic.uuid);
          })
          .then(function () {
            return waitingPromise(3000);
          });
      });
    }
    return result;
  }

  function attachCharacteristicPromise(promise, characteristic) {
    return promise.then(function () {
      log("Handling characteristic", characteristic.uuid);
      addNotificationHandler(characteristic);
      return createCharacteristicPromise(characteristic);
    });
  }

  function attachCharacteristics() {
    setCoreState(CORE_STATE.ATTACHING);
    var characteristicsPromise = Promise.resolve();
    characteristics.forEach(function (characteristic) {
      characteristicsPromise = attachCharacteristicPromise(characteristicsPromise, characteristic);
    });
    return characteristicsPromise.then(function () {
      if (!hasRequiredCoreCharacteristics(characteristics)) {
        throw new Error("Missing required CORE characteristics");
      }
      log("Connection established, waiting for notifications");
    });
  }

  function discoverCharacteristics(currentGatt) {
    setCoreState(CORE_STATE.DISCOVERING);
    characteristics = [];
    controlPointChar = undefined;
    log("Runtime discovery: getting services");
    return currentGatt.getPrimaryServices().then(function (services) {
      log("Runtime discovery: got services", services.length);
      var result = Promise.resolve();
      services.forEach(function (service) {
        if (supportedServices.indexOf(service.uuid) < 0) return;
        result = result.then(function () {
          log("Runtime discovery: supporting service", service.uuid);
          return service.getCharacteristics().then(function (chars) {
            chars.forEach(function (characteristic) {
              if (supportedCharacteristicUUIDs.indexOf(characteristic.uuid) < 0) return;
              log("Runtime discovery: supporting characteristic", characteristic.uuid);
              characteristics.push(characteristic);
            });
          });
        });
      });
      return result;
    }).then(function () {
      if (!hasRequiredCoreCharacteristics(characteristics)) {
        throw new Error("Runtime discovery missing required CORE characteristics");
      }
      return attachCharacteristics();
    }).then(function () {
      log("Runtime discovery: complete, saving cache");
      saveCache(characteristics);
    });
  }

  function attachCachedOrDiscover() {
    // Cached handles are the fast path. If they fail once, drop them and rebuild
    // from live discovery rather than looping forever on stale GATT metadata.
    var usedCache = false;
    if (!characteristics || characteristics.length === 0) {
      characteristics = characteristicsFromCache(device);
      usedCache = characteristics.length > 0;
    }

    if (characteristics.length > 0) {
      return attachCharacteristics().catch(function (e) {
        if (!usedCache) throw e;
        log("Cached characteristics failed, rebuilding cache", e);
        deleteCache();
        characteristics = [];
        controlPointChar = undefined;
        return discoverCharacteristics(gatt);
      });
    }

    log("No cached characteristics, performing runtime discovery");
    return discoverCharacteristics(gatt);
  }

  function resetTransportState(reason) {
    log("resetTransportState", reason);
    flushLog();
    rejectActiveControlPoint(new Error("CORE transport closed: " + reason));
    controlPointChar = undefined;
    lastReceivedData = {};
    characteristics = [];
    gatt = undefined;
    device = undefined;
  }

  function cleanupGatt(reason) {
    log("cleanupGatt", reason);
    var currentGatt = gatt;
    var currentDevice = device;
    resetTransportState(reason);
    if (currentGatt && currentGatt.connected) {
      expectedDisconnectDevice = currentDevice;
      try {
        currentGatt.disconnect();
      } catch (e) {
        expectedDisconnectDevice = undefined;
        log("cleanup disconnect error", e);
      }
    }
  }

  function scheduleReconnect(reason) {
    if (reconnectTimer || !shouldBeConnected || pendingDisconnect || pendingUnpair) return;
    var delay = reconnectDelayMs;
    increaseReconnectBackoff();
    pendingReconnect = true;
    setCoreState(CORE_STATE.RECONNECT_WAIT, delay);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = undefined;
      if (shouldBeConnected && !pendingDisconnect && !pendingUnpair) {
        enqueueLifecycle("reconnect", function () {
          pendingReconnect = true;
        }).catch(function (e) {
          log("Reconnect task failed", e);
        });
      } else {
        setCoreState(CORE_STATE.IDLE, reason || "power released before reconnect");
      }
    }, delay);
  }

  function enqueueLifecycle(kind, mutator) {
    if (mutator) mutator();
    lifecycleQueue = lifecycleQueue.then(function () {
      activeLifecycleTask = { kind: kind };
      log("Lifecycle task start", kind);
      return reconcileLifecycle(kind).then(function (result) {
        log("Lifecycle task done", kind);
        activeLifecycleTask = undefined;
        return result;
      }, function (err) {
        log("Lifecycle task error", { kind: kind, error: String(err) });
        activeLifecycleTask = undefined;
        throw err;
      });
    }, function () {
      activeLifecycleTask = { kind: kind };
      log("Lifecycle task retry", kind);
      return reconcileLifecycle(kind).then(function (result) {
        activeLifecycleTask = undefined;
        return result;
      }, function (err) {
        activeLifecycleTask = undefined;
        throw err;
      });
    });
    return lifecycleQueue;
  }

  function ensureConnectionDesiredOrThrow(stage) {
    if (!shouldBeConnected || pendingDisconnect || pendingUnpair) {
      var powerErr = new Error("CORESensor power off before " + stage);
      powerErr.coreContext = "power_off";
      throw powerErr;
    }
  }

  function ensureDeviceAvailable() {
    ensureConnectionDesiredOrThrow("connect");
    if (device) {
      log("Reuse device", device);
      return Promise.resolve(device);
    }
    setCoreState(CORE_STATE.SCANNING);
    NRF.setScan();
    var filters = [{ id: settings.btid }];
    log("Requesting device with filters", filters);
    return NRF.requestDevice({ filters: filters, active: true })
      .then(function (d) {
        return waitingPromise(2000).then(function () {
          return d;
        });
      })
      .then(function (d) {
        log("Got device", d);
        if (!d._coretempDisconnectHandlerAdded) {
          d._coretempDisconnectHandlerAdded = true;
          d.on("gattserverdisconnected", function (reason) {
            onDisconnect(d, reason);
          });
        }
        device = d;
        return d;
      }, function (err) {
        err.coreContext = "request_device";
        throw err;
      });
  }

  function ensureGattConnected() {
    ensureConnectionDesiredOrThrow("connect");
    if (!device) {
      var err = new Error("CORE device is unavailable");
      err.coreContext = "connect";
      throw err;
    }
    gatt = device.gatt;
    if (gatt.connected) return ensureBonded(gatt);
    setCoreState(CORE_STATE.CONNECTING);
    log("Connecting...");
    return gatt.connect()
      .then(function () {
        log("Connected.");
      })
      .then(function () {
        return waitingPromise(2000);
      })
      .then(function () {
        return ensureBonded(gatt);
      }, function (err) {
        if (!err.coreContext) err.coreContext = "connect";
        throw err;
      });
  }

  function ensureTransportReady() {
    ensureConnectionDesiredOrThrow("attach");
    if (isTransportReady()) {
      setCoreState(CORE_STATE.CONNECTED, "transport already ready");
      return Promise.resolve();
    }
    return attachCachedOrDiscover();
  }

  function performConnectSequence() {
    return ensureDeviceAvailable()
      .then(function () {
        return ensureGattConnected();
      })
      .then(function () {
        return ensureTransportReady();
      })
      .then(function () {
        lastError = undefined;
        pendingReconnect = false;
        resetReconnectBackoff();
        setCoreState(CORE_STATE.CONNECTED);
      })
      .catch(function (err) {
        if (String(err).indexOf("power off") >= 0) err.coreContext = "power_off";
        else if (!err.coreContext && coreState === CORE_STATE.DISCOVERING) err.coreContext = "discover";
        else if (!err.coreContext && coreState === CORE_STATE.ATTACHING) err.coreContext = "attach";
        else if (!err.coreContext) err.coreContext = "connect";
        throw err;
      });
  }

  function handleLifecycleFailure(err) {
    var context = err.coreContext || "connect";
    lastError = String(err);
    log("BLE failure", { context: context, error: lastError });
    setCoreState(CORE_STATE.ERROR, context);

    if (context === "no_pairing") {
      clearReconnectTimer();
      pendingReconnect = false;
      setCoreState(CORE_STATE.IDLE, context);
      throw err;
    }

    if (context === "power_off") {
      clearReconnectTimer();
      cleanupGatt(context);
      return waitForBleSettle(context).then(function () {
        setCoreState(CORE_STATE.IDLE, context);
        throw err;
      });
    }

    cleanupGatt(context);
    return waitForBleSettle(context).then(function () {
      if (shouldBeConnected && !pendingDisconnect && !pendingUnpair && settings.btid) {
        scheduleReconnect(context);
      } else {
        pendingReconnect = false;
        clearReconnectTimer();
        setCoreState(CORE_STATE.IDLE, context);
      }
      throw err;
    });
  }

  function performBusyRetry(attempt, err) {
    lastError = String(err);
    log("BLE stack busy", { attempt: attempt, error: lastError });
    setCoreState(CORE_STATE.ERROR, "stack busy");
    cleanupGatt("stack busy");
    return waitForBleSettle("stack busy");
  }

  function reconcileLifecycle(kind) {
    readCoreSettings();

    if (pendingUnpair) {
      clearReconnectTimer();
      pendingReconnect = false;
      shouldBeConnected = false;
      setCoreState(CORE_STATE.DISCONNECTING, "unpair");
      cleanupGatt("unpair");
      return waitForBleSettle("unpair").then(function () {
        writeCoreSettings(function (nextSettings) {
          delete nextSettings.btid;
          delete nextSettings.btname;
          delete nextSettings.cache;
        });
        pendingUnpair = false;
        pendingDisconnect = false;
        pendingPairTarget = undefined;
        pendingRebuildCache = false;
        setCoreState(CORE_STATE.IDLE, "unpaired");
      });
    }

    if (pendingDisconnect) {
      clearReconnectTimer();
      pendingReconnect = false;
      shouldBeConnected = false;
      setCoreState(CORE_STATE.DISCONNECTING, "requested disconnect");
      cleanupGatt("requested disconnect");
      return waitForBleSettle("requested disconnect").then(function () {
        pendingDisconnect = false;
        setCoreState(CORE_STATE.IDLE, "requested disconnect");
      });
    }

    if (pendingPairTarget) {
      clearReconnectTimer();
      pendingReconnect = false;
      shouldBeConnected = true;
      setCoreState(CORE_STATE.DISCONNECTING, "pair target");
      cleanupGatt("pair target");
      return waitForBleSettle("pair target").then(function () {
        var pairTarget = pendingPairTarget;
        pendingPairTarget = undefined;
        writeCoreSettings(function (nextSettings) {
          nextSettings.btid = pairTarget.id;
          if (pairTarget.name) nextSettings.btname = pairTarget.name;
          else delete nextSettings.btname;
          delete nextSettings.cache;
        });
        pendingRebuildCache = false;
        return connectWithBusyRetry();
      });
    }

    if (pendingRebuildCache) {
      clearReconnectTimer();
      pendingReconnect = false;
      shouldBeConnected = true;
      setCoreState(CORE_STATE.DISCONNECTING, "rebuild cache");
      cleanupGatt("rebuild cache");
      deleteCache();
      return waitForBleSettle("rebuild cache").then(function () {
        pendingRebuildCache = false;
        return connectWithBusyRetry();
      });
    }

    if (pendingReconnect) {
      clearReconnectTimer();
      setCoreState(CORE_STATE.DISCONNECTING, "reconnect requested");
      cleanupGatt("reconnect requested");
      return waitForBleSettle("reconnect requested").then(function () {
        return connectWithBusyRetry();
      }).then(function (result) {
        pendingReconnect = false;
        return result;
      });
    }

    if (!shouldBeConnected) {
      clearReconnectTimer();
      if (gatt || device) {
        setCoreState(CORE_STATE.DISCONNECTING, "no connection requested");
        cleanupGatt("no connection requested");
        return waitForBleSettle("no connection requested").then(function () {
          setCoreState(CORE_STATE.IDLE, "no connection requested");
        });
      }
      setCoreState(CORE_STATE.IDLE, "no connection requested");
      return Promise.resolve();
    }

    if (!settings.btid) {
      pendingReconnect = false;
      clearReconnectTimer();
      lastError = "CORE device is not paired";
      setCoreState(CORE_STATE.IDLE, "no_pairing");
      if (kind === "connect" || kind === "power_on" || kind === "reconnect") {
        var pairErr = new Error("CORE device is not paired");
        pairErr.coreContext = "no_pairing";
        throw pairErr;
      }
      return Promise.resolve();
    }

    return connectWithBusyRetry();
  }

  function connectWithBusyRetry() {
    var attempts = 0;
    function attemptConnect() {
      attempts++;
      return performConnectSequence().catch(function (err) {
        if (isBleBusyError(err) && shouldBeConnected && attempts < BLE_BUSY_RETRY_LIMIT) {
          return performBusyRetry(attempts, err).then(function () {
            return attemptConnect();
          });
        }
        return handleLifecycleFailure(err);
      });
    }
    return attemptConnect();
  }

  function isTransientOwner(owner) {
    return owner === "coretemp.settings" ||
      owner === "coretemp.pair" ||
      owner === "coretemp.rebuild";
  }

  function runWithTemporaryPower(owner, fn) {
    // Pair/rebuild helpers may need transport briefly even when no app/recorder
    // owns CORE power. Acquire a temporary owner and always release it here.
    var acquiredPower = false;
    if (!Bangle.isCORESensorOn()) {
      Bangle.setCORESensorPower(1, owner);
      acquiredPower = true;
    }
    var promise;
    try {
      promise = Promise.resolve(fn());
    } catch (e) {
      promise = Promise.reject(e);
    }
    return promise.then(function (result) {
      if (acquiredPower) Bangle.setCORESensorPower(0, owner);
      return result;
    }, function (err) {
      if (acquiredPower) Bangle.setCORESensorPower(0, owner);
      throw err;
    });
  }

  function onDisconnect(disconnectedDevice, reason) {
    if (expectedDisconnectDevice && expectedDisconnectDevice === disconnectedDevice) {
      expectedDisconnectDevice = undefined;
      log("Ignoring expected disconnect", reason);
      return;
    }
    log("Disconnect", reason);
    lastError = "Disconnected: " + reason;
    resetTransportState("disconnect");
    if (shouldBeConnected && !pendingDisconnect && !pendingUnpair && Bangle.isCORESensorOn()) {
      scheduleReconnect("disconnect");
    } else {
      pendingReconnect = false;
      clearReconnectTimer();
      setCoreState(CORE_STATE.IDLE, "disconnect while off");
    }
  }

  function requestTransportReconnect(reason, err) {
    log("Request transport reconnect", { reason: reason, error: String(err) });
    lastError = String(err);
    if (!shouldBeConnected || pendingDisconnect || pendingUnpair || !Bangle.isCORESensorOn()) return;
    pendingReconnect = true;
    enqueueLifecycle("transport_recovery", function () {
      pendingReconnect = true;
    }).catch(function (queueErr) {
      log("Transport recovery failed", queueErr);
    });
  }

  Bangle.CORESensorConnect = function () {
    readCoreSettings();
    if (!Bangle.isCORESensorOn()) {
      return Promise.reject(new Error("CORESensor has no power owner"));
    }
    if (!settings.btid) {
      return Promise.reject(new Error("CORE device is not paired"));
    }
    return enqueueLifecycle("connect", function () {
      pendingDisconnect = false;
      pendingUnpair = false;
      pendingReconnect = false;
      shouldBeConnected = true;
    });
  };

  Bangle.CORESensorDisconnect = function () {
    return enqueueLifecycle("disconnect", function () {
      clearReconnectTimer();
      pendingReconnect = false;
      pendingDisconnect = true;
      shouldBeConnected = false;
    });
  };

  Bangle.CORESensorPair = function (deviceId, deviceName) {
    if (!deviceId) return Promise.reject(new Error("Missing CORE device id"));
    return runWithTemporaryPower("coretemp.pair", function () {
      return enqueueLifecycle("pair", function () {
        clearReconnectTimer();
        pendingReconnect = false;
        pendingDisconnect = false;
        pendingUnpair = false;
        pendingRebuildCache = false;
        pendingPairTarget = {
          id: deviceId,
          name: deviceName
        };
        shouldBeConnected = true;
      });
    });
  };

  Bangle.CORESensorUnpair = function () {
    return enqueueLifecycle("unpair", function () {
      clearReconnectTimer();
      pendingReconnect = false;
      pendingDisconnect = false;
      pendingUnpair = true;
      shouldBeConnected = false;
    });
  };

  Bangle.CORESensorRebuildCache = function () {
    readCoreSettings();
    if (!settings.btid) return Promise.reject(new Error("CORE device is not paired"));
    return runWithTemporaryPower("coretemp.rebuild", function () {
      return enqueueLifecycle("rebuild", function () {
        clearReconnectTimer();
        pendingReconnect = false;
        pendingDisconnect = false;
        pendingRebuildCache = true;
        shouldBeConnected = true;
      });
    });
  };

  Bangle.CORESensorWriteControlPoint = function (opCode, params) {
    params = params || [];
    var write = function () {
      return new Promise(function (resolve, reject) {
        if (!controlPointChar || !gatt || !gatt.connected) {
          reject(new Error("CORE control point is not connected"));
          return;
        }
        var data = new Uint8Array([opCode].concat(params));
        var timeout = setTimeout(function () {
          if (activeControlPointRequest && activeControlPointRequest.opCode === opCode) {
            activeControlPointRequest = undefined;
          }
          reject(new Error("CORE control point timeout for opcode " + opCode));
        }, 10000);
        activeControlPointRequest = {
          opCode: opCode,
          resolve: resolve,
          reject: reject,
          timeout: timeout
        };
        controlPointChar.writeValue(data).then(function () {
          log("Sent control point opcode", opCode);
        }).catch(function (e) {
          if (activeControlPointRequest && activeControlPointRequest.opCode === opCode) {
            activeControlPointRequest = undefined;
          }
          clearTimeout(timeout);
          if (isBleTransportError(e)) {
            requestTransportReconnect("control_point_transport", e);
          }
          reject(e);
        });
      });
    };
    controlPointQueue = controlPointQueue.then(write, write);
    return controlPointQueue;
  };

  Bangle.CORESensorGetStatus = function () {
    readCoreSettings();
    return {
      enabled: settings.enabled === true,
      paired: !!settings.btid,
      deviceId: settings.btid,
      deviceName: settings.btname,
      state: coreState,
      connected: !!(gatt && gatt.connected),
      reconnectScheduled: !!reconnectTimer,
      hasCache: !!(settings.cache && settings.cache.characteristics),
      lastError: lastError,
      activeTask: activeLifecycleTask && activeLifecycleTask.kind,
      desiredConnected: !!shouldBeConnected,
      pendingReconnect: !!pendingReconnect
    };
  };

  Bangle.setCORESensorPower = function (isOn, app) {
    if (!app) app = "?";
    log("setCORESensorPower ->", { on: !!isOn, owner: app });
    if (Bangle._PWR === undefined) Bangle._PWR = {};
    if (Bangle._PWR.CORESensor === undefined) Bangle._PWR.CORESensor = [];
    if (isOn && Bangle._PWR.CORESensor.indexOf(app) < 0) Bangle._PWR.CORESensor.push(app);
    if (!isOn && Bangle._PWR.CORESensor.indexOf(app) >= 0) {
      Bangle._PWR.CORESensor = Bangle._PWR.CORESensor.filter(function (owner) {
        return owner !== app;
      });
    }
    if (Bangle._PWR.CORESensor.length > 0) {
      if (isTransientOwner(app)) return;
      if (!pendingDisconnect && !pendingUnpair) shouldBeConnected = true;
      enqueueLifecycle("power_on", function () {
        if (!pendingDisconnect && !pendingUnpair) shouldBeConnected = true;
      }).catch(function (e) {
        log("Auto connect failed", e);
      });
    } else {
      shouldBeConnected = false;
      enqueueLifecycle("power_off", function () {
        clearReconnectTimer();
        pendingReconnect = false;
        pendingDisconnect = true;
        shouldBeConnected = false;
      }).catch(function (e) {
        log("CORESensor disconnect error", e);
      });
    }
  };

  E.on("kill", function () {
    flushLog();
    clearReconnectTimer();
    if (logFlushInterval) {
      clearInterval(logFlushInterval);
      logFlushInterval = undefined;
    }
    shouldBeConnected = false;
    pendingReconnect = false;
    pendingDisconnect = false;
    pendingUnpair = false;
    pendingPairTarget = undefined;
    pendingRebuildCache = false;
    if (gatt || device) {
      setCoreState(CORE_STATE.DISCONNECTING, "kill");
      cleanupGatt("kill");
    }
  });
};
