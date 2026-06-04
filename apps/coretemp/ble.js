var store = require("coretemp.store");
var protocol = require("coretemp.protocol");
var controlpoint = require("coretemp.controlpoint");

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

var initialized;
var gatt;
var device;
var characteristics = [];
var controlPointChar;
var reconnectTimer;
var reconnectDelayMs = RECONNECT_DELAY_MIN_MS;
var expectedDisconnectDevice;
var batteryLevel = 0;
var coreState = CORE_STATE.IDLE;
var lastError;
var lifecycleQueue = Promise.resolve();
var activeLifecycleTask;
var shouldBeConnected = false;
var pendingReconnect = false;
var pendingRebuildCache = false;
var pendingPairTarget;
var activePairTarget;
var pendingUnpair = false;
var pendingDisconnect = false;
var connectedHandlers = [];
var connectionSessionId = 0;

function log(text, param) {
  store.log(text, param);
}

function notifyConnectedHandlers(sessionId) {
  var promise = Promise.resolve();
  connectedHandlers.forEach(function (handler) {
    promise = promise.then(function () {
      return handler(sessionId);
    }).catch(function (err) {
      log("CORE connected handler failed", err);
    });
  });
  return promise;
}

function readSettings() {
  return store.read();
}

function writeSettings(mutator) {
  return store.write(mutator);
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

function ensureBonded(currentGatt) {
  var status;
  if (!currentGatt || !currentGatt.getSecurityStatus) return Promise.resolve();
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
  var msg = String(err).toLowerCase();
  return msg.indexOf("in progress") >= 0;
}

function setControlPointCharacteristic(characteristic) {
  controlPointChar = characteristic;
  if (!controlPointChar) {
    controlpoint.setAdapter(undefined);
    return;
  }
  controlpoint.setAdapter({
    write: function (bytes) {
      return controlPointChar.writeValue(new Uint8Array(bytes));
    },
    log: log
  });
}

function addNotificationHandler(characteristic) {
  if (characteristic._coretempHandlerAdded) return;
  characteristic._coretempHandlerAdded = true;
  characteristic.on("characteristicvaluechanged", function (ev) {
    if (characteristic.uuid === protocol.CORE_TEMP_UUID) {
      var data = protocol.parseMeasurement(ev.target.value, batteryLevel);
      log("data", data);
      Bangle.emit("CORESensor", data);
    } else if (characteristic.uuid === protocol.CORE_CONTROL_POINT_UUID) {
      log("Control point response", protocol.dataViewToArray(ev.target.value));
      controlpoint.onNotification(ev.target.value);
    } else if (characteristic.uuid === "0x2a19") {
      batteryLevel = protocol.parseBattery(ev.target.value);
      log("Got battery", batteryLevel);
    }
  });
}

function characteristicsFromCache(currentDevice) {
  var cache = store.get().cache;
  var restored = [];
  var service = { device: currentDevice };
  var cached;
  var characteristic;
  var uuid;
  if (!cache || !cache.characteristics) return restored;
  log("Read cached characteristics");
  for (uuid in cache.characteristics) {
    if (!cache.characteristics.hasOwnProperty(uuid)) continue;
    cached = cache.characteristics[uuid];
    characteristic = new BluetoothRemoteGATTCharacteristic();
    characteristic.handle_value = cached.handle;
    characteristic.uuid = cached.uuid;
    characteristic.properties = {
      notify: cached.notify,
      indicate: cached.indicate,
      read: cached.read,
      write: cached.write
    };
    characteristic.service = service;
    addNotificationHandler(characteristic);
    restored.push(characteristic);
  }
  return restored;
}

function saveCache(chars) {
  writeSettings(function (nextSettings) {
    var cache = { characteristics: {} };
    chars.forEach(function (characteristic) {
      cache.characteristics[characteristic.uuid] = {
        handle: characteristic.handle_value,
        uuid: characteristic.uuid,
        notify: characteristic.properties.notify,
        indicate: characteristic.properties.indicate,
        read: characteristic.properties.read,
        write: characteristic.properties.write
      };
    });
    nextSettings.cache = cache;
  });
}

function deleteCache() {
  writeSettings(function (nextSettings) {
    delete nextSettings.cache;
  });
}

function hasRequiredCoreCharacteristics(chars) {
  var uuids = chars.map(function (characteristic) {
    return characteristic.uuid;
  });
  return uuids.indexOf(protocol.CORE_TEMP_UUID) >= 0 &&
    uuids.indexOf(protocol.CORE_CONTROL_POINT_UUID) >= 0;
}

function isTransportReady() {
  return !!(gatt && gatt.connected && controlPointChar && hasRequiredCoreCharacteristics(characteristics));
}

function createCharacteristicPromise(characteristic) {
  var result = Promise.resolve();
  var supportsUpdates;
  if (characteristic.uuid === protocol.CORE_CONTROL_POINT_UUID) setControlPointCharacteristic(characteristic);
  supportsUpdates = characteristic.uuid === protocol.CORE_CONTROL_POINT_UUID ||
    (characteristic.properties &&
      (characteristic.properties.notify || characteristic.properties.indicate));
  if (characteristic.properties && characteristic.properties.read) {
    result = result.then(function () {
      log("Reading data", characteristic.uuid);
      return characteristic.readValue().then(function (data) {
        if (characteristic.uuid === "0x2a19") batteryLevel = protocol.parseBattery(data);
      });
    });
  }
  if (supportsUpdates) {
    result = result.then(function () {
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

function attachCharacteristics() {
  var promise = Promise.resolve();
  setCoreState(CORE_STATE.ATTACHING);
  characteristics.forEach(function (characteristic) {
    promise = promise.then(function () {
      addNotificationHandler(characteristic);
      return createCharacteristicPromise(characteristic);
    });
  });
  return promise.then(function () {
    if (!hasRequiredCoreCharacteristics(characteristics)) {
      throw new Error("Missing required CORE characteristics");
    }
  });
}

function discoverCharacteristics(currentGatt) {
  setCoreState(CORE_STATE.DISCOVERING);
  characteristics = [];
  setControlPointCharacteristic(undefined);
  log("Runtime discovery: getting services");
  return currentGatt.getPrimaryServices().then(function (services) {
    var promise = Promise.resolve();
    log("Runtime discovery: got services", services.length);
    services.forEach(function (service) {
      if (protocol.SUPPORTED_SERVICES.indexOf(service.uuid) < 0) return;
      promise = promise.then(function () {
        return service.getCharacteristics().then(function (chars) {
          chars.forEach(function (characteristic) {
            if (protocol.SUPPORTED_CHARACTERISTIC_UUIDS.indexOf(characteristic.uuid) < 0) return;
            characteristics.push(characteristic);
          });
        });
      });
    });
    return promise;
  }).then(function () {
    if (!hasRequiredCoreCharacteristics(characteristics)) {
      throw new Error("Runtime discovery missing required CORE characteristics");
    }
    return attachCharacteristics();
  }).then(function () {
    saveCache(characteristics);
  });
}

function attachCachedOrDiscover() {
  var usedCache = false;
  if (activePairTarget) return discoverCharacteristics(gatt);
  if (!characteristics.length) {
    characteristics = characteristicsFromCache(device);
    usedCache = characteristics.length > 0;
  }
  if (!characteristics.length) return discoverCharacteristics(gatt);
  return attachCharacteristics().catch(function (err) {
    if (!usedCache) throw err;
    log("Cached characteristics failed, rebuilding cache", err);
    deleteCache();
    characteristics = [];
    setControlPointCharacteristic(undefined);
    return discoverCharacteristics(gatt);
  });
}

function resetTransportState(reason) {
  log("resetTransportState", reason);
  store.flush();
  controlpoint.cancelActive("CORE transport closed: " + reason);
  setControlPointCharacteristic(undefined);
  characteristics = [];
  batteryLevel = 0;
  gatt = undefined;
  device = undefined;
}

function cleanupGatt(reason) {
  var currentGatt = gatt;
  var currentDevice = device;
  log("cleanupGatt", reason);
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
  var delay = reconnectDelayMs;
  if (reconnectTimer || !shouldBeConnected || pendingDisconnect || pendingUnpair) return;
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
      activeLifecycleTask = undefined;
      log("Lifecycle task done", kind);
      return result;
    }, function (err) {
      activeLifecycleTask = undefined;
      log("Lifecycle task error", { kind: kind, error: String(err) });
      throw err;
    });
  }, function () {
    activeLifecycleTask = { kind: kind };
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
  var powerErr;
  if (!shouldBeConnected || pendingDisconnect || pendingUnpair) {
    powerErr = new Error("CORESensor power off before " + stage);
    powerErr.coreContext = "power_off";
    throw powerErr;
  }
}

function ensureDisconnectHandler(bleDevice) {
  if (!bleDevice || bleDevice._coretempDisconnectHandlerAdded) return bleDevice;
  bleDevice._coretempDisconnectHandlerAdded = true;
  bleDevice.on("gattserverdisconnected", function (reason) {
    onDisconnect(bleDevice, reason);
  });
  return bleDevice;
}

function ensureDeviceAvailable() {
  var filters;
  var targetId;
  ensureConnectionDesiredOrThrow("connect");
  if (device) {
    ensureDisconnectHandler(device);
    log("Reuse device", device);
    return Promise.resolve(device);
  }
  setCoreState(CORE_STATE.SCANNING);
  NRF.setScan();
  targetId = activePairTarget && activePairTarget.id ? activePairTarget.id : store.get().btid;
  filters = [{ id: targetId }];
  return NRF.requestDevice({ filters: filters, active: true })
    .then(function (foundDevice) {
      return waitingPromise(2000).then(function () {
        return foundDevice;
      });
    })
    .then(function (foundDevice) {
      device = ensureDisconnectHandler(foundDevice);
      return foundDevice;
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
  return gatt.connect()
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
    .then(ensureGattConnected)
    .then(ensureTransportReady)
    .then(function () {
      lastError = undefined;
      pendingReconnect = false;
      resetReconnectBackoff();
      connectionSessionId++;
      setCoreState(CORE_STATE.CONNECTED);
      return notifyConnectedHandlers(connectionSessionId);
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
  var isPairAttempt = !!activePairTarget || !!(activeLifecycleTask && activeLifecycleTask.kind === "pair");
  var settings = store.get();
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
    if (isPairAttempt) {
      pendingReconnect = false;
      clearReconnectTimer();
      setCoreState(CORE_STATE.IDLE, context);
    } else if (shouldBeConnected && !pendingDisconnect && !pendingUnpair && settings.btid) {
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
  var settings = readSettings();
  if (pendingUnpair) {
    clearReconnectTimer();
    pendingReconnect = false;
    shouldBeConnected = false;
    setCoreState(CORE_STATE.DISCONNECTING, "unpair");
    cleanupGatt("unpair");
    return waitForBleSettle("unpair").then(function () {
      writeSettings(function (nextSettings) {
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
      activePairTarget = pairTarget;
      if (pairTarget && pairTarget.device) device = pairTarget.device;
      pendingRebuildCache = false;
      return connectWithBusyRetry().then(function (result) {
        writeSettings(function (nextSettings) {
          nextSettings.btid = pairTarget.id;
          if (pairTarget.name) nextSettings.btname = pairTarget.name;
          else delete nextSettings.btname;
        });
        activePairTarget = undefined;
        return result;
      }, function (err) {
        activePairTarget = undefined;
        throw err;
      });
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
        return performBusyRetry(attempts, err).then(attemptConnect);
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

function isOn() {
  return !!(Bangle._PWR && Bangle._PWR.CORESensor && Bangle._PWR.CORESensor.length);
}

function isConnected() {
  return !!(gatt && gatt.connected);
}

function runWithTemporaryPower(owner, fn) {
  var acquiredPower = false;
  var promise;
  if (!isOn()) {
    setPower(1, owner);
    acquiredPower = true;
  }
  try {
    promise = Promise.resolve(fn());
  } catch (e) {
    promise = Promise.reject(e);
  }
  return promise.then(function (result) {
    if (acquiredPower) setPower(0, owner);
    return result;
  }, function (err) {
    if (acquiredPower) setPower(0, owner);
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
  if (shouldBeConnected && !pendingDisconnect && !pendingUnpair && isOn()) {
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
  if (!shouldBeConnected || pendingDisconnect || pendingUnpair || !isOn()) return;
  pendingReconnect = true;
  enqueueLifecycle("transport_recovery", function () {
    pendingReconnect = true;
  }).catch(function (queueErr) {
    log("Transport recovery failed", queueErr);
  });
}

function connect() {
  readSettings();
  if (!isOn()) return Promise.reject(new Error("CORESensor has no power owner"));
  if (!store.get().btid) return Promise.reject(new Error("CORE device is not paired"));
  return enqueueLifecycle("connect", function () {
    pendingDisconnect = false;
    pendingUnpair = false;
    pendingReconnect = false;
    shouldBeConnected = true;
  });
}

function disconnect() {
  return enqueueLifecycle("disconnect", function () {
    clearReconnectTimer();
    pendingReconnect = false;
    pendingDisconnect = true;
    shouldBeConnected = false;
  });
}

function pairDevice(deviceOrId, deviceName) {
  var pairTarget;
  if (deviceOrId && typeof deviceOrId === "object") {
    if (!deviceOrId.id) return Promise.reject(new Error("Missing CORE device id"));
    pairTarget = {
      id: deviceOrId.id,
      name: deviceOrId.name,
      device: deviceOrId
    };
  } else {
    if (!deviceOrId) return Promise.reject(new Error("Missing CORE device id"));
    pairTarget = {
      id: deviceOrId,
      name: deviceName
    };
  }
  return runWithTemporaryPower("coretemp.pair", function () {
    return enqueueLifecycle("pair", function () {
      clearReconnectTimer();
      pendingReconnect = false;
      pendingDisconnect = false;
      pendingUnpair = false;
      pendingRebuildCache = false;
      pendingPairTarget = pairTarget;
      shouldBeConnected = true;
    });
  });
}

function unpairDevice() {
  return enqueueLifecycle("unpair", function () {
    clearReconnectTimer();
    pendingReconnect = false;
    pendingDisconnect = false;
    pendingUnpair = true;
    shouldBeConnected = false;
  });
}

function rebuildCache() {
  readSettings();
  if (!store.get().btid) return Promise.reject(new Error("CORE device is not paired"));
  return runWithTemporaryPower("coretemp.rebuild", function () {
    return enqueueLifecycle("rebuild", function () {
      clearReconnectTimer();
      pendingReconnect = false;
      pendingDisconnect = false;
      pendingRebuildCache = true;
      shouldBeConnected = true;
    });
  });
}

function writeControlPoint(opCode, params, options) {
  if (!controlPointChar || !gatt || !gatt.connected) {
    return Promise.reject(new Error("CORE control point is not connected"));
  }
  return controlpoint.request(opCode, params, options).catch(function (err) {
    if (isBleTransportError(err)) requestTransportReconnect("control_point_transport", err);
    throw err;
  });
}

function getStatus() {
  readSettings();
  return {
    enabled: store.get().enabled === true,
    paired: !!store.get().btid,
    deviceId: store.get().btid,
    deviceName: store.get().btname,
    state: coreState,
    connected: !!(gatt && gatt.connected),
    reconnectScheduled: !!reconnectTimer,
    hasCache: !!(store.get().cache && store.get().cache.characteristics),
    lastError: lastError,
    activeTask: activeLifecycleTask && activeLifecycleTask.kind,
    desiredConnected: !!shouldBeConnected,
    pendingReconnect: !!pendingReconnect
  };
}

function setPower(isOnValue, app) {
  if (!app) app = "?";
  if (Bangle._PWR === undefined) Bangle._PWR = {};
  if (Bangle._PWR.CORESensor === undefined) Bangle._PWR.CORESensor = [];
  log("setCORESensorPower ->", { on: !!isOnValue, owner: app });
  if (isOnValue && Bangle._PWR.CORESensor.indexOf(app) < 0) Bangle._PWR.CORESensor.push(app);
  if (!isOnValue && Bangle._PWR.CORESensor.indexOf(app) >= 0) {
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
}

function runWithConnectedSession(owner, fn) {
  return runWithTemporaryPower(owner, function () {
    return connect().then(function () {
      return fn();
    });
  });
}

exports.init = function () {
  if (initialized) return;
  initialized = true;
};

exports.isOn = isOn;
exports.isConnected = isConnected;
exports.connect = connect;
exports.disconnect = disconnect;
exports.pairDevice = pairDevice;
exports.unpairDevice = unpairDevice;
exports.rebuildCache = rebuildCache;
exports.writeControlPoint = writeControlPoint;
exports.getStatus = getStatus;
exports.setPower = setPower;
exports.runWithConnectedSession = runWithConnectedSession;
exports.onConnected = function (handler) {
  if (typeof handler !== "function") return;
  connectedHandlers.push(handler);
};

exports.shutdown = function () {
  store.flush();
  clearReconnectTimer();
  shouldBeConnected = false;
  pendingReconnect = false;
  pendingDisconnect = false;
  pendingUnpair = false;
  pendingPairTarget = undefined;
  activePairTarget = undefined;
  pendingRebuildCache = false;
  if (gatt || device) {
    setCoreState(CORE_STATE.DISCONNECTING, "kill");
    cleanupGatt("kill");
  }
};
