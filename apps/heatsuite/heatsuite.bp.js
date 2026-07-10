var Layout = require("Layout");
const modHS = require('HSModule');
var layout;
var settings = modHS.getSettings();

var BP_SERVICE_UUID = "1810";
var BP_DATE_TIME_UUID = "2A08";
var BP_MEASUREMENT_UUID = "2A35";
var BP_CONNECT_SETTLE_MS = 2500;
var BP_MEASUREMENT_TIMEOUT_MS = 120000;
var BP_INDICATION_IDLE_EXIT_MS = 2000;
var BP_EXIT_DELAY_MS = 3000;
var BP_PAIRING_ERROR = "BP cuff is not paired. Pair in Settings with START held until PR.";

function isBPSecurityError(e) {
  var msg = (e && e.message) ? e.message : String(e);
  msg = msg.toLowerCase();
  return msg.indexOf("security") >= 0 ||
    msg.indexOf("auth") >= 0 ||
    msg.indexOf("encrypt") >= 0 ||
    msg.indexOf("bond") >= 0 ||
    msg.indexOf("pair") >= 0 ||
    msg.indexOf("insufficient") >= 0;
}

function debugEnabled() {
  return !!(settings.DEBUG || settings.SAVE_DEBUG);
}

function log() {
  if (!debugEnabled()) return;
  var parts = [];
  for (var i = 0; i < arguments.length; i++) {
    parts.push(String(arguments[i]));
  }
  if (modHS.log) modHS.log(parts.join(" "));
  else console.log(parts.join(" "));
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

function byteToHex(value) {
  var out = (value & 0xFF).toString(16);
  return out.length < 2 ? "0" + out : out;
}

function dataViewToHex(data) {
  var bytes = [];
  for (var i = 0; i < data.byteLength; i++) {
    bytes.push(byteToHex(data.getUint8(i)));
  }
  return bytes.join(" ");
}

function getSecurityStatus(device) {
  if (!device || !device.getSecurityStatus) return {};
  try {
    return device.getSecurityStatus() || {};
  } catch (e) {
    log("BP security status failed", e);
    return {};
  }
}

function logSecurityStatus(label, device) {
  log(label, safeStringify(getSecurityStatus(device)));
}

function showMessage(title, msg) {
  layout = new Layout({
    type: "v", c: [
      {
        type: "h", c: [
          { type: "txt", font: "6x8:2", label: title, fillx: 1, wrap: true },
        ]
      },
      {
        type: "h", c: [
          { type: "txt", font: "6x8:1", label: msg || "", fillx: 1, wrap: true },
        ]
      }
    ]
  });
  g.clear();
  layout.render();
}

function showWaiting() {
  showMessage("Blood Pressure", "Waiting...");
}

function showSavedResult(receivedData, savedCount) {
  var savedLabel = savedCount > 1 ? "Saved x" + savedCount : "Saved!";
  layout = new Layout({
    type: "v", c: [
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: receivedData.sbp, fillx: 1 },
          { type: "txt", font: "12x20:2", label: "/", fillx: 1 },
          { type: "txt", font: "12x20:2", label: receivedData.dbp, fillx: 1 }
        ]
      },
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: receivedData.hr === null ? "--" : receivedData.hr, fillx: 1 },
          { type: "txt", font: "12x20:2", label: "BPM", fillx: 1 },
        ]
      },
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: savedLabel, fillx: 1 }
        ]
      },
    ]
  });
  g.clear();
  layout.render();
}

function decodeSFloat16(raw) {
  raw = raw & 0xFFFF;
  if (raw === 0x07FE) return Infinity;
  if (raw === 0x0802) return -Infinity;
  if (raw === 0x07FF || raw === 0x0800 || raw === 0x0801) return null;

  var mantissa = raw & 0x0FFF;
  var exponent = raw >> 12;
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  if (exponent >= 0x08) exponent -= 0x10;
  var value = mantissa * Math.pow(10, exponent);
  return Math.round(value * 1000000) / 1000000;
}

function requireBytes(data, index, count, label) {
  if (index + count > data.byteLength) {
    throw new Error("Truncated BP measurement: " + label);
  }
}

function readSFloat(data, index, label) {
  requireBytes(data, index, 2, label);
  return decodeSFloat16(data.getUint16(index, true));
}

function parseBPMeasurement(data, deviceId) {
  requireBytes(data, 0, 1, "flags");
  var flags = data.getUint8(0);
  var index = 1;
  var result = {
    "deviceId": deviceId || null,
    "rawFlags": flags,
    "unit": (flags & 0x01) ? "kPa" : "mmHg",
    "sbp": null,
    "dbp": null,
    "map": null,
    "hr": null,
    "year": null,
    "month": null,
    "day": null,
    "hour": null,
    "minute": null,
    "second": null,
    "userId": null,
    "moved": null,
    "cuffLoose": null,
    "irregularPulse": null,
    "improperMeasure": null,
    "bodyMovementDetected": null,
    "measurementPositionImproper": null
  };

  result.sbp = readSFloat(data, index, "systolic");
  index += 2;
  result.dbp = readSFloat(data, index, "diastolic");
  index += 2;
  result.map = readSFloat(data, index, "mean arterial pressure");
  index += 2;

  if (flags & 0x02) {
    requireBytes(data, index, 7, "timestamp");
    result.year = data.getUint16(index, true);
    result.month = data.getUint8(index + 2);
    result.day = data.getUint8(index + 3);
    result.hour = data.getUint8(index + 4);
    result.minute = data.getUint8(index + 5);
    result.second = data.getUint8(index + 6);
    index += 7;
  }
  if (flags & 0x04) {
    result.hr = readSFloat(data, index, "pulse rate");
    index += 2;
  }
  if (flags & 0x08) {
    requireBytes(data, index, 1, "user id");
    result.userId = data.getUint8(index);
    index += 1;
  }
  if (flags & 0x10) {
    requireBytes(data, index, 2, "measurement status");
    var status = data.getUint16(index, true);
    result.moved = (status & 0x0001) ? 1 : 0;
    result.bodyMovementDetected = result.moved;
    result.cuffLoose = (status & 0x0002) ? 1 : 0;
    result.irregularPulse = (status & 0x0004) ? 1 : 0;
    result.improperMeasure = (status & 0x0020) ? 1 : 0;
    result.measurementPositionImproper = result.improperMeasure;
    index += 2;
  }

  return result;
}

function buildDateTimePayload(date) {
  var arr = new Uint8Array(7);
  var v = new DataView(arr.buffer);
  v.setUint16(0, date.getFullYear(), true);
  v.setUint8(2, date.getMonth() + 1);
  v.setUint8(3, date.getDate());
  v.setUint8(4, date.getHours());
  v.setUint8(5, date.getMinutes());
  v.setUint8(6, date.getSeconds());
  return arr;
}

function trySyncDeviceTime(service) {
  return service.getCharacteristic(BP_DATE_TIME_UUID).then(function (characteristic) {
    return characteristic.writeValue(buildDateTimePayload(new Date())).then(function () {
      log("BP time sync complete");
      return true;
    });
  }).catch(function (e) {
    log("BP time sync skipped", e);
    return false;
  });
}

function disconnectDevice(device) {
  if (!device || !device.disconnect) return;
  if (device.connected === false) return;
  try {
    device.disconnect();
  } catch (e) {
    log("BP disconnect failed", e);
  }
}

function exitSoon(delay) {
  setTimeout(function () {
    Bangle.load();
  }, delay || BP_EXIT_DELAY_MS);
}

function getBP(id) {
  if (!id) {
    log("BP start failed: no paired device id");
    showMessage("ERROR!", "No BP device paired");
    exitSoon();
    return Promise.resolve(false);
  }

  showWaiting();
  log("BP start", id);
  var device;
  var measurementTimeout;
  var indicationIdleTimeout;
  var finished = false;
  var savedCount = 0;
  var measurementReady = false;
  var disconnectedBeforeReady = false;
  var lastReceivedData = null;
  var resultPromptTimeout = null;

  function showResultPrompt(text) {
    if (resultPromptTimeout) clearTimeout(resultPromptTimeout);
    resultPromptTimeout = setTimeout(function () {
      resultPromptTimeout = null;
      Bangle.load();
    }, 10000);
    E.showPrompt(text, { title: "BP Result", buttons: { "OK": true } }).then(function () {
      if (resultPromptTimeout) {
        clearTimeout(resultPromptTimeout);
        resultPromptTimeout = null;
      }
      Bangle.load();
    });
  }

  function clearMeasurementTimeout() {
    if (measurementTimeout) {
      clearTimeout(measurementTimeout);
      measurementTimeout = undefined;
    }
  }

  function clearIndicationIdleTimeout() {
    if (indicationIdleTimeout) {
      clearTimeout(indicationIdleTimeout);
      indicationIdleTimeout = undefined;
    }
  }

  function clearTimeouts() {
    clearMeasurementTimeout();
    clearIndicationIdleTimeout();
  }

  function finishSuccess() {
    if (finished) return;
    finished = true;
    clearTimeouts();
    log("BP finish success", "saved=" + savedCount);
    disconnectDevice(device);
    var resultText = "Saved!";
    if (lastReceivedData) {
      resultText = lastReceivedData.sbp + "/" + lastReceivedData.dbp + " mmHg\n" +
        (lastReceivedData.hr !== null ? lastReceivedData.hr + " BPM" : "") +
        (savedCount > 1 ? "\nSaved x" + savedCount : "");
    }
    showResultPrompt(resultText);
  }

  function scheduleFinishAfterIdle() {
    clearIndicationIdleTimeout();
    log("BP idle exit scheduled", BP_INDICATION_IDLE_EXIT_MS);
    indicationIdleTimeout = setTimeout(finishSuccess, BP_INDICATION_IDLE_EXIT_MS);
  }

  function fail(e) {
    clearTimeouts();
    disconnectDevice(device);
    var msg = e && e.message ? e.message : String(e);
    log("BP failed", msg);
    showMessage("ERROR!", msg);
    exitSoon();
  }

  function attachDisconnectHandler() {
    if (device.device && device.device.on) {
      device.device.on('gattserverdisconnected', function (reason) {
        if (device) device.connected = false;
        log("BP disconnected", reason);
        if (!finished) {
          if (!measurementReady && savedCount === 0) {
            disconnectedBeforeReady = true;
            return;
          }
          finished = true;
          clearTimeouts();
          if (savedCount > 0) {
            disconnectDevice(device);
            var dcText = lastReceivedData
              ? lastReceivedData.sbp + "/" + lastReceivedData.dbp + " mmHg\n" +
                (lastReceivedData.hr !== null ? lastReceivedData.hr + " BPM" : "") +
                (savedCount > 1 ? "\nSaved x" + savedCount : "")
              : "Saved!";
            showResultPrompt(dcText);
            return;
          }
          showMessage("ERROR!", "BP disconnected");
          exitSoon();
        }
      });
    }
  }

  function connectDevice() {
    disconnectedBeforeReady = false;
    if (NRF.setScan) {
      log("BP stop active scan before connect");
      NRF.setScan();
    }
    log("BP connect start", id);
    return NRF.connect(id).then(function (d) {
      device = d;
      attachDisconnectHandler();
      log("BP connected", id);
      logSecurityStatus("BP security after connect", device);
      log("BP settle", BP_CONNECT_SETTLE_MS);
      return new Promise(function (resolve) {
        setTimeout(resolve, BP_CONNECT_SETTLE_MS);
      });
    }).then(function () {
      if (disconnectedBeforeReady || (device && device.connected === false)) {
        throw new Error("Disconnected");
      }
      var security = getSecurityStatus(device);
      log("BP security after settle", safeStringify(security));
      if (security && security.bonded === false) {
        throw new Error(BP_PAIRING_ERROR);
      }
      if (security && security.bonded) log("BP already bonded");
      return device;
    });
  }

  function subscribeToMeasurement() {
    if (!device || device.connected === false || disconnectedBeforeReady) {
      throw new Error("Disconnected");
    }
    log("BP get service", BP_SERVICE_UUID);
    return device.getPrimaryService(BP_SERVICE_UUID);
  }

  function setupMeasurement() {
    return subscribeToMeasurement().then(function (s) {
      log("BP service ready", BP_SERVICE_UUID);
      return trySyncDeviceTime(s).then(function () {
        return s;
      });
    }).then(function (s) {
      log("BP get characteristic", BP_MEASUREMENT_UUID);
      return s.getCharacteristic(BP_MEASUREMENT_UUID);
    }).then(function (c) {
      c.on('characteristicvaluechanged', function (event) {
        if (finished) return;
        try {
          if (debugEnabled()) log("BP payload raw", dataViewToHex(event.target.value));
          var receivedData = parseBPMeasurement(event.target.value, id);
          log("BP payload parsed", safeStringify(receivedData));
          modHS.saveDataToFile('bpres', 'bloodPressure', receivedData);
          savedCount++;
          lastReceivedData = receivedData;
          log("BP saved", "count=" + savedCount);
          clearMeasurementTimeout();
          showSavedResult(receivedData, savedCount);
          scheduleFinishAfterIdle();
        } catch (e) {
          finished = true;
          fail(e);
        }
      });
      log("BP start notifications", BP_MEASUREMENT_UUID);
      return c.startNotifications().then(function () {
        log("BP notifications started", BP_MEASUREMENT_UUID);
      });
    });
  }

  function normalizeSetupError(e) {
    if (!isBPSecurityError(e)) throw e;
    throw new Error(BP_PAIRING_ERROR);
  }

  return connectDevice().then(setupMeasurement).catch(normalizeSetupError).then(function () {
    if (finished) return false;
    measurementReady = true;
    log("BP waiting for measurement notifications");
    log("BP measurement timeout scheduled", BP_MEASUREMENT_TIMEOUT_MS);
    measurementTimeout = setTimeout(function () {
      if (finished) return;
      finished = true;
      fail(new Error("BP measurement timeout"));
    }, BP_MEASUREMENT_TIMEOUT_MS);
    return true;
  }).catch(function (e) {
    if (finished) return false;
    finished = true;
    fail(e);
    return false;
  });
}

function startBP() {
  settings = modHS.getSettings();
  var id = settings.bt_bloodPressure_id;
  return getBP(id);
}

setTimeout(startBP, 2000);
