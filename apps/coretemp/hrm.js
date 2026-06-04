var ble = require("coretemp.ble");
var protocol = require("coretemp.protocol");
var store = require("coretemp.store");

var managerState = "idle";
var lastError;
var lastStatus;
var lastConfiguredSent = false;
var operationQueue = Promise.resolve();
var activeOperation;

var HRM_CONFIG_FILE = "coretemp.hrm.json";
var DEFAULT_STALE_RESPONSE_RETRIES = 0;
var SCAN_START_STALE_RETRIES = 1;
var SCAN_COUNT_STALE_RETRIES = 2;
var SCAN_ENTRY_STALE_RETRIES = 1;
var PAIRED_COUNT_STALE_RETRIES = 1;
var PAIRED_ENTRY_STALE_RETRIES = 1;

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

function makeUnknownEntry(index, err) {
  return {
    index: index,
    transport: "ANT+",
    antId: undefined,
    txType: 0,
    state: 0,
    stateText: "Unknown",
    entryReadable: false,
    lastEntryError: err !== undefined ? String(err) : undefined
  };
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
  return writeExpectedControlPoint(
    protocol.OPCODES.HRM_PAIRED_COUNT,
    undefined,
    "paired HRM count",
    { staleRetries: PAIRED_COUNT_STALE_RETRIES }
  ).then(function (response) {
    var count = protocol.parseCount(response);
    var entries = [];
    var promise = Promise.resolve();
    var i;

    for (i = 0; i < count; i++) {
      (function (index) {
        promise = promise.then(function () {
          return writeExpectedControlPoint(
            protocol.OPCODES.HRM_PAIRED_ANT_ENTRY,
            [index],
            "paired HRM entry",
            { staleRetries: PAIRED_ENTRY_STALE_RETRIES }
          )
            .then(function (entryResponse) {
              entries.push(protocol.parseAntEntry(entryResponse, index));
            })
            .catch(function (err) {
              store.log("Failed to query paired HRM entry " + index, err);
              entries.push(makeUnknownEntry(index, err));
            });
        });
      })(i);
    }
    return promise.then(function () {
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
  setState(state || "sending_preset");
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

function isStaleResponse(response, requestOpcode) {
  return response &&
    typeof response === "object" &&
    response.length !== undefined &&
    response[0] === protocol.OPCODES.RESPONSE &&
    response[1] !== requestOpcode;
}

function writeExpectedControlPoint(opcode, params, label, options) {
  var writeOptions;
  var staleRetries;
  var attempt = 0;
  options = options || {};
  writeOptions = {};
  if (options.expectResponse !== undefined) writeOptions.expectResponse = options.expectResponse;
  if (options.timeoutMs !== undefined) writeOptions.timeoutMs = options.timeoutMs;
  staleRetries = options.staleRetries !== undefined ?
    options.staleRetries :
    DEFAULT_STALE_RESPONSE_RETRIES;

  function write() {
    return ble.writeControlPoint(opcode, params, writeOptions).then(function (response) {
      try {
        return expectResponse(response, opcode, label);
      } catch (err) {
        if (isStaleResponse(response, opcode) && attempt < staleRetries) {
          attempt++;
          store.log(label + " retry after stale response", response);
          return write();
        }
        throw err;
      }
    }, function (err) {
      if (isStaleResponse(err, opcode) && attempt < staleRetries) {
        attempt++;
        store.log(label + " retry after stale response", err);
        return write();
      }
      throw err;
    });
  }

  return write();
}

exports.init = function () {
  setState("idle");
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

exports.sendPreset = function () {
  var config = readConfiguredHRM();

  if (!config.valid) {
    lastError = "No valid ANT+ HRM preset configured";
    setState("error", lastError);
    lastStatus = buildStatus(config, lastStatus && lastStatus.pairedSensors);
    return Promise.reject(new Error(lastError));
  }

  return enqueueOperation("send_preset", function () {
    return withSession("sending_preset", config, function () {
      return sendConfiguredToConnectedCore(config, "sending_preset");
    });
  });
};

exports.ensureConfigured = exports.sendPreset;

exports.scanANT = function () {
  var config = readConfiguredHRM();
  return enqueueOperation("scan_ant", function () {
    return withSession("scanning_ant", config, function () {
      return writeExpectedControlPoint(
        protocol.OPCODES.HRM_SCAN_ANT_START,
        [0xFF],
        "ANT+ scan start",
        { staleRetries: SCAN_START_STALE_RETRIES }
      ).then(function (response) {
        store.log("ANT+ scan start response", response);
        return waitForScanWindow();
      }).then(function () {
        return writeExpectedControlPoint(
          protocol.OPCODES.HRM_SCAN_ANT_COUNT,
          undefined,
          "ANT+ scan count",
          { staleRetries: SCAN_COUNT_STALE_RETRIES }
        );
      }).then(function (response) {
        var count = protocol.parseCount(response);
        var found = [];
        var requests = [];
        var i;
        for (i = 0; i < count; i++) {
          (function (index) {
            requests.push(
              writeExpectedControlPoint(
                protocol.OPCODES.HRM_SCAN_ANT_ENTRY,
                [index],
                "ANT+ scan entry",
                { staleRetries: SCAN_ENTRY_STALE_RETRIES }
              ).then(function (entryResponse) {
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
