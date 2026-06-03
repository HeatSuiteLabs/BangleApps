var ble = require("coretemp.ble");
var protocol = require("coretemp.protocol");
var store = require("coretemp.store");

var managerState = "idle";
var lastError;
var lastStatus;
var lastAutoConfiguredSessionId;
var lastConfiguredSent = false;
var operationQueue = Promise.resolve();
var activeOperation;

var HRM_CONFIG_FILE = "coretemp.hrm.json";

function isPairAntTimeout(err) {
  return String(err).indexOf("opcode " + protocol.OPCODES.HRM_PAIR_ANT) >= 0;
}

function isPairedCountTimeout(err) {
  return String(err).indexOf("opcode " + protocol.OPCODES.HRM_PAIRED_COUNT) >= 0;
}

function normalizeConfiguredAntId(id) {
  if (typeof id === "string" && /^\d+$/.test(id.trim())) {
    id = parseInt(id, 10);
  }
  if (typeof id !== "number" || isNaN(id) || (id | 0) !== id) return undefined;
  if (id <= 0 || id > 0xffffff) return undefined;
  return id;
}

function readConfiguredHRM() {
  var config = require("Storage").readJSON(HRM_CONFIG_FILE, 1) || {};
  var transport = config.transport || "ANT+";
  var antId = normalizeConfiguredAntId(config.antId);
  var valid = transport === "ANT+" && antId !== undefined;

  if (!valid && config.antId !== undefined) {
    store.log("Configured ANT+ HRM id ignored", config);
  }

  return {
    transport: transport,
    antId: antId,
    autoConnect: config.autoConnect !== false,
    valid: valid
  };
}

function setState(nextState, reason) {
  managerState = nextState;
  if (reason !== undefined) store.log("HRM state -> " + nextState, reason);
  else store.log("HRM state -> " + nextState);
}

function makeSyntheticEntry(id, stateText) {
  return {
    index: 0,
    transport: "ANT+",
    antId: id,
    txType: (id >> 16) & 0xFF,
    state: stateText === "Synchronized" ? 2 : 1,
    stateText: stateText || "Searching"
  };
}

function emptyUnknownEntries() {
  var entries = [];
  entries.pairedCountKnown = false;
  return entries;
}

function buildStatus(config, entries) {
  var active;
  var current;
  var multiple;
  var pairedCountKnown;
  var i;

  config = config || readConfiguredHRM();
  entries = entries || [];
  pairedCountKnown = entries.pairedCountKnown !== false;
  multiple = entries.length > 1;

  for (i = 0; i < entries.length; i++) {
    if (entries[i].stateText === "Synchronized" && !active) active = entries[i];
    if (
      !current &&
      (entries[i].stateText === "Synchronized" || entries[i].stateText === "Searching")
    ) {
      current = entries[i];
    }
  }

  return {
    managerState: managerState,
    configuredTransport: config.transport,
    configuredAntId: config.antId,
    configuredAutoConnect: config.autoConnect,
    configuredValid: config.valid,
    lastSent: !!lastConfiguredSent,
    paired: entries.length > 0,
    pairedCount: entries.length,
    pairedCountKnown: pairedCountKnown,
    pairedSensors: entries,
    multiplePaired: multiple,
    transport: entries.length ? "ANT+" : null,
    currentSource: multiple ? null : (current || entries[0] || null),
    activeSource: multiple ? null : (active || null),
    connected: multiple ? false : !!active,
    syncState: multiple ?
      "multiple" :
      (active ? "synchronized" : (current ? "searching" : (entries.length ? "paired" : "none"))),
    lastError: lastError
  };
}

function finishStatus(config, entries) {
  lastError = undefined;
  setState("idle");
  lastStatus = buildStatus(config, entries);
  return lastStatus;
}

function handleFailure(err, config) {
  lastError = String(err);
  setState("error", lastError);
  lastStatus = buildStatus(config, lastStatus && lastStatus.pairedSensors);
  throw err;
}

function withSession(state, config, fn) {
  setState(state);
  return ble.runWithConnectedSession("coretemp.hrm", fn).then(
    function (result) {
      return result;
    },
    function (err) {
      return handleFailure(err, config);
    }
  );
}

function enqueueOperation(name, fn) {
  operationQueue = operationQueue.catch(function () { }).then(function () {
    activeOperation = name;
    return Promise.resolve().then(fn).then(function (result) {
      activeOperation = undefined;
      return result;
    }, function (err) {
      activeOperation = undefined;
      throw err;
    });
  });
  return operationQueue;
}

function queryEntries() {
  return ble.writeControlPoint(protocol.OPCODES.HRM_PAIRED_COUNT).then(function (response) {
    var count = protocol.parseCount(response);
    var entries = [];
    var requests = [];
    var i;

    for (i = 0; i < count; i++) {
      (function (index) {
        requests.push(
          ble.writeControlPoint(protocol.OPCODES.HRM_PAIRED_ANT_ENTRY, [index])
            .then(function (entryResponse) {
              entries.push(protocol.parseAntEntry(entryResponse, index));
            })
            .catch(function (err) {
              store.log("Failed to query paired HRM entry " + index, err);
              entries.push({
                index: index,
                transport: "ANT+",
                antId: undefined,
                txType: 0,
                state: 0,
                stateText: "Unknown"
              });
            })
        );
      })(i);
    }
    return Promise.all(requests).then(function () {
      entries.sort(function (a, b) { return a.index - b.index; });
      return entries;
    });
  });
}

function queryEntriesAllowUnknown() {
  return queryEntries().catch(function (err) {
    if (!isPairedCountTimeout(err)) throw err;
    return emptyUnknownEntries();
  });
}

function sendConfiguredToConnectedCore(config, state) {
  setState(state || "configuring_ant");
  store.log("Sending configured ANT+ HRM id", config.antId);
  return ble.writeControlPoint(
    protocol.OPCODES.HRM_PAIR_ANT,
    protocol.makeAntPairParams(config.antId)
  ).catch(function (err) {
    if (isPairAntTimeout(err)) {
      throw new Error(
        "Timed out waiting for CORE control point response 0x80 for HRM pair opcode"
      );
    }
    throw err;
  }).then(function () {
    lastConfiguredSent = true;
    return queryEntriesAllowUnknown().then(function (entries) {
      if (!entries.length && config.antId !== undefined) {
        entries = [makeSyntheticEntry(config.antId, "Searching")];
      }
      return finishStatus(config, entries);
    });
  });
}

function waitForScanWindow() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 10000);
  });
}

function expectResponse(response, requestOpcode, label) {
  if (!response || response[0] !== protocol.OPCODES.RESPONSE) {
    throw new Error(label + " invalid response: " + response);
  }
  if (response[1] !== requestOpcode) {
    throw new Error(
      label + " got stale/wrong response: " + response +
      " expected opcode " + requestOpcode
    );
  }
  if (response[2] !== 0x01) {
    throw new Error(label + " failed: " + response);
  }
  return response;
}

exports.init = function () {
  setState("idle");
  lastAutoConfiguredSessionId = undefined;
  lastConfiguredSent = false;
  lastStatus = buildStatus();
};

exports.getManagerState = function () {
  return {
    state: managerState,
    busy: !!activeOperation,
    activeOperation: activeOperation,
    lastError: lastError,
    lastStatus: lastStatus
  };
};

exports.getStatus = function () {
  var config = readConfiguredHRM();
  return enqueueOperation("get_status", function () {
    return withSession("querying", config, function () {
      return queryEntriesAllowUnknown().then(function (entries) {
        return finishStatus(config, entries);
      });
    });
  });
};

exports.ensureConfigured = function () {
  var config = readConfiguredHRM();

  if (!config.valid || config.autoConnect === false) {
    lastStatus = buildStatus(config, lastStatus && lastStatus.pairedSensors);
    return Promise.resolve(lastStatus);
  }

  return enqueueOperation("ensure_configured", function () {
    return withSession("configuring_ant", config, function () {
      return sendConfiguredToConnectedCore(config, "configuring_ant");
    });
  });
};

exports.autoConfigureForConnection = function (sessionId) {
  var config = readConfiguredHRM();

  if (!config.valid || config.autoConnect === false) {
    lastStatus = buildStatus(config, lastStatus && lastStatus.pairedSensors);
    return Promise.resolve(lastStatus);
  }
  if (lastAutoConfiguredSessionId === sessionId) {
    return Promise.resolve(lastStatus || buildStatus(config));
  }
  lastAutoConfiguredSessionId = sessionId;
  return enqueueOperation("auto_configure", function () {
    return sendConfiguredToConnectedCore(config, "configuring_ant_auto").catch(
      function (err) {
        lastError = String(err);
        lastStatus = buildStatus(config, lastStatus && lastStatus.pairedSensors);
        setState("error", lastError);
        throw err;
      }
    );
  });
};

exports.scanANT = function () {
  var config = readConfiguredHRM();
  return enqueueOperation("scan_ant", function () {
    return withSession("scanning_ant", config, function () {
      return ble.writeControlPoint(
        protocol.OPCODES.HRM_SCAN_ANT_START,
        [0xFF]
      ).then(function (response) {
        expectResponse(response, protocol.OPCODES.HRM_SCAN_ANT_START, "ANT+ scan start");
        store.log("ANT+ scan start response", response);
        return waitForScanWindow();
      }).then(function () {
        return ble.writeControlPoint(protocol.OPCODES.HRM_SCAN_ANT_COUNT);
      }).then(function (response) {
        expectResponse(response, protocol.OPCODES.HRM_SCAN_ANT_COUNT, "ANT+ scan count");
        var count = protocol.parseCount(response);
        var found = [];
        var requests = [];
        var i;
        for (i = 0; i < count; i++) {
          (function (index) {
            requests.push(
              ble.writeControlPoint(protocol.OPCODES.HRM_SCAN_ANT_ENTRY, [index]).then(function (entryResponse) {
                found.push(protocol.parseAntEntry(entryResponse, index));
              })
            );
          })(i);
        }
        return Promise.all(requests).then(function () {
          found.sort(function (a, b) {
            return a.index - b.index;
          });
          lastError = undefined;
          setState("idle");
          return found;
        });
      });
    });
  });
};

exports.pairANT = function (id) {
  var config = readConfiguredHRM();
  id = normalizeConfiguredAntId(id);
  if (id === undefined) return Promise.reject(new Error("Invalid ANT+ HRM id"));
  return enqueueOperation("pair_ant", function () {
    return withSession("pairing_ant", config, function () {
      return queryEntriesAllowUnknown().then(function (entries) {
        if (entries.length > 1) {
          throw new Error("Multiple HRMs are paired on CORE. Clear paired HRMs before pairing one ANT+ sensor.");
        }
        if (entries.length === 1) {
          if (entries[0].antId === id) return finishStatus(config, entries);
          throw new Error("A HRM is already paired on CORE. Clear paired HRM before pairing another ANT+ sensor.");
        }
        return ble.writeControlPoint(
          protocol.OPCODES.HRM_PAIR_ANT,
          protocol.makeAntPairParams(id)
        ).catch(function (err) {
          if (isPairAntTimeout(err)) {
            throw new Error(
              "Timed out waiting for CORE control point response 0x80 for HRM pair opcode"
            );
          }
          throw err;
        }).then(function () {
          return queryEntriesAllowUnknown().then(function (pairedEntries) {
            if (!pairedEntries.length) pairedEntries = [makeSyntheticEntry(id, "Searching")];
            return finishStatus(config, pairedEntries);
          });
        });
      });
    });
  });
};

exports.clear = function () {
  var config = readConfiguredHRM();
  return enqueueOperation("clear_ant", function () {
    return withSession("clearing", config, function () {
      return ble.writeControlPoint(protocol.OPCODES.HRM_CLEAR_ANT).then(function () {
        return queryEntriesAllowUnknown().then(function (entries) {
          return finishStatus(config, entries);
        });
      });
    });
  });
};
