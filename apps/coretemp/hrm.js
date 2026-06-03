var ble = require("coretemp.ble");
var protocol = require("coretemp.protocol");
var store = require("coretemp.store");

var managerState = "idle";
var lastError;
var lastStatus;
var lastScan;

var HRM_CONFIG_FILE = "coretemp.hrm.json";
var LEGACY_HRM_ID_FILE = "coretemp.hrm-id.json";
var ANT_SCAN_WILDCARD = 0xff;
var DEFAULT_ANT_SCAN_DURATION_MS = 10000;
var MIN_ANT_SCAN_DURATION_MS = 3000;
var MAX_ANT_SCAN_DURATION_MS = 30000;
var DEFAULT_ANT_SCAN_ATTEMPTS = 1;
var MAX_ANT_SCAN_ATTEMPTS = 3;
var DEFAULT_MAX_SCAN_ENTRIES = 8;
var MAX_SCAN_ENTRIES = 16;

function isPairedCountTimeout(err) {
  return (
    String(err).indexOf("opcode " + protocol.OPCODES.HRM_PAIRED_COUNT) >= 0
  );
}

function makeSyntheticEntry(id, stateText) {
  return {
    index: 0,
    transport: "ANT+",
    antId: id,
    txType: (id >> 16) & 0xff,
    state: stateText === "Synchronized" ? 2 : 1,
    stateText: stateText || "Searching",
  };
}

function normalizeConfiguredAntId(id) {
  var hex;
  var txType;
  var deviceNumber;

  if (id === undefined || id === null || id === "") return undefined;

  if (typeof id === "number") {
    if (id > 0 && id <= 0xffffff) return id;
    return undefined;
  }

  if (typeof id !== "string") return undefined;

  id = id.trim();
  if (!id) return undefined;

  if (/^\d+$/.test(id)) {
    id = parseInt(id, 10);
    if (id > 0 && id <= 0xffffff) return id;
    return undefined;
  }

  hex = id.replace(/^0x/i, "").toUpperCase();

  if (/^[0-9A-F]{6}$/.test(hex)) {
    return parseInt(hex, 16);
  }

  // Accept full ANT+ HRM ids like EA78562C and reduce them to txType+deviceNumber.
  if (/^[0-9A-F]{8}$/.test(hex) && hex.substr(2, 2) === "78") {
    txType = parseInt(hex.substr(0, 2), 16);
    deviceNumber = parseInt(hex.substr(4, 4), 16);
    return deviceNumber | (txType << 16);
  }

  return undefined;
}

function readConfiguredHRM() {
  var config = require("Storage").readJSON(HRM_CONFIG_FILE, 1);
  var rawId;
  var antId;

  if (!config) config = require("Storage").readJSON(LEGACY_HRM_ID_FILE, 1);
  if (!config) return {};

  rawId = config.antId;
  if (rawId === undefined) rawId = config.id;
  if (rawId === undefined) rawId = config.hrm_id;

  antId = normalizeConfiguredAntId(rawId);
  if (antId === undefined && rawId !== undefined) {
    store.log("Configured ANT+ HRM id ignored", config);
  }

  return {
    antId: antId,
    autoConnect: config.autoConnect !== false,
    transport: config.transport,
  };
}

function setState(nextState, reason) {
  managerState = nextState;
  if (reason !== undefined) store.log("HRM state -> " + nextState, reason);
  else store.log("HRM state -> " + nextState);
}

function buildStatus(entries) {
  entries = entries || [];
  var active;
  var current;
  var multiple = entries.length > 1;
  var pairedCountKnown = entries.pairedCountKnown !== false;
  var i;
  for (i = 0; i < entries.length; i++) {
    if (entries[i].stateText === "Synchronized" && !active) active = entries[i];
    if (
      !current &&
      (entries[i].stateText === "Synchronized" ||
        entries[i].stateText === "Searching")
    ) {
      current = entries[i];
    }
  }
  return {
    managerState: managerState,
    paired: entries.length > 0,
    pairedCount: entries.length,
    pairedCountKnown: pairedCountKnown,
    pairedSensors: entries,
    multiplePaired: multiple,
    transport: entries.length ? "ANT+" : null,
    currentSource: multiple ? null : current || entries[0] || null,
    activeSource: multiple ? null : active || null,
    connected: multiple ? false : !!active,
    syncState: multiple
      ? "multiple"
      : active
        ? "synchronized"
        : current
          ? "searching"
          : entries.length
            ? "paired"
            : "none",
    lastError: lastError,
  };
}

function toBoundedInteger(value, fallback, min, max) {
  value = parseInt(value, 10);
  if (isNaN(value)) value = fallback;
  if (value < min) value = min;
  if (value > max) value = max;
  return value;
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function sortByIndex(entries) {
  return entries.sort(function (a, b) {
    return a.index - b.index;
  });
}

function parseBoundedCount(response, label, maxCount) {
  var count = parseInt(protocol.parseCount(response), 10);
  if (isNaN(count) || count < 0)
    throw new Error(label + " returned invalid count");
  if (maxCount !== undefined && count > maxCount) {
    store.log(label + " count capped", count + " -> " + maxCount);
    return maxCount;
  }
  return count;
}

function readIndexedAntEntries(entryOpcode, count) {
  var entries = [];
  var chain = Promise.resolve();
  var i;

  for (i = 0; i < count; i++) {
    (function (index) {
      chain = chain.then(function () {
        return ble
          .writeControlPoint(entryOpcode, [index])
          .then(function (entryResponse) {
            entries.push(protocol.parseAntEntry(entryResponse, index));
          });
      });
    })(i);
  }

  return chain.then(function () {
    return sortByIndex(entries);
  });
}

function queryEntries() {
  return ble
    .writeControlPoint(protocol.OPCODES.HRM_PAIRED_COUNT)
    .then(function (response) {
      return readIndexedAntEntries(
        protocol.OPCODES.HRM_ENTRY,
        parseBoundedCount(response, "HRM paired", MAX_SCAN_ENTRIES),
      );
    });
}

function queryEntriesAllowTimeout() {
  return queryEntries().catch(function (err) {
    if (!isPairedCountTimeout(err)) throw err;
    return emptyUnknownEntries();
  });
}

function ensureConfiguredPairing(entries) {
  var config = readConfiguredHRM();
  var configuredAntId = config.antId;
  entries = entries || [];
  if (configuredAntId === undefined) return Promise.resolve(entries);
  if (config.transport && config.transport !== "ANT+") {
    store.log("Configured HRM transport ignored", config.transport);
    return Promise.resolve(entries);
  }
  if (config.autoConnect === false) return Promise.resolve(entries);
  if (entries.length > 1) {
    store.log(
      "Configured ANT+ HRM id skipped",
      "multiple HRMs already paired on CORE",
    );
    return Promise.resolve(entries);
  }
  if (entries.length === 1) {
    if (entries[0].antId === configuredAntId) return Promise.resolve(entries);
    store.log(
      "Configured ANT+ HRM id skipped",
      "different HRM already paired on CORE",
    );
    return Promise.resolve(entries);
  }
  store.log("Applying configured ANT+ HRM id", configuredAntId);
  return ble
    .writeControlPoint(
      protocol.OPCODES.HRM_PAIR_ANT,
      protocol.makeAntPairParams(configuredAntId),
    )
    .then(function () {
      return queryEntries()
        .catch(function (err) {
          if (!isPairedCountTimeout(err)) throw err;
          return [makeSyntheticEntry(configuredAntId, "Searching")];
        });
    });
}

function normalizeScanOptions(options) {
  options = options || {};
  return {
    durationMs: toBoundedInteger(
      options.durationMs || options.scanDurationMs,
      DEFAULT_ANT_SCAN_DURATION_MS,
      MIN_ANT_SCAN_DURATION_MS,
      MAX_ANT_SCAN_DURATION_MS,
    ),
    attempts: toBoundedInteger(
      options.attempts,
      DEFAULT_ANT_SCAN_ATTEMPTS,
      1,
      MAX_ANT_SCAN_ATTEMPTS,
    ),
    maxEntries: toBoundedInteger(
      options.maxEntries,
      DEFAULT_MAX_SCAN_ENTRIES,
      1,
      MAX_SCAN_ENTRIES,
    ),
  };
}

function scanAntOnce(options, attempt) {
  store.log(
    "ANT+ HRM scan start",
    "attempt " +
      attempt +
      "/" +
      options.attempts +
      ", duration " +
      options.durationMs +
      "ms",
  );

  return ble
    .writeControlPoint(protocol.OPCODES.HRM_SCAN_START, [ANT_SCAN_WILDCARD], {
      expectResponse: false,
    })
    .then(function () {
      return delay(options.durationMs);
    })
    .then(function () {
      return ble.writeControlPoint(protocol.OPCODES.HRM_SCAN_COUNT);
    })
    .then(function (response) {
      var count = parseBoundedCount(response, "HRM scan", options.maxEntries);
      return readIndexedAntEntries(protocol.OPCODES.HRM_SCAN_ENTRY, count);
    });
}

function scanAntWithRetry(options, attempt) {
  return scanAntOnce(options, attempt).then(function (found) {
    if (found.length || attempt >= options.attempts) return found;
    store.log("ANT+ HRM scan found no devices", "retrying");
    return delay(250).then(function () {
      return scanAntWithRetry(options, attempt + 1);
    });
  });
}

function finishScan(found) {
  found = found || [];
  lastError = undefined;
  lastScan = {
    count: found.length,
    sensors: found,
    timestamp: Date.now ? Date.now() : undefined,
  };
  setState("idle");
  return found;
}

function emptyUnknownEntries() {
  var entries = [];
  entries.pairedCountKnown = false;
  return entries;
}

function finishStatus(entries) {
  entries = entries || [];
  lastError = undefined;
  lastStatus = buildStatus(entries);
  setState("idle");
  return lastStatus;
}

function handleFailure(nextState, err) {
  lastError = String(err);
  setState("error", lastError);
  if (nextState) setState(nextState);
  throw err;
}

function withSession(state, fn) {
  setState(state);
  return ble.runWithConnectedSession("coretemp.hrm", fn).then(
    function (result) {
      return result;
    },
    function (err) {
      return handleFailure(undefined, err);
    },
  );
}

exports.init = function () {
  setState("idle");
};

exports.getManagerState = function () {
  return {
    state: managerState,
    lastError: lastError,
    lastStatus: lastStatus,
    lastScan: lastScan,
  };
};

exports.getStatus = function () {
  return withSession("querying", function () {
    return queryEntriesAllowTimeout()
      .then(ensureConfiguredPairing)
      .then(finishStatus);
  });
};

exports.scanANT = function (options) {
  options = normalizeScanOptions(options);
  return withSession("scanning_ant", function () {
    return scanAntWithRetry(options, 1).then(finishScan);
  });
};

exports.discoverANT = exports.scanANT;

exports.pairANT = function (id) {
  return withSession("pairing_ant", function () {
    return queryEntriesAllowTimeout()
      .then(function (entries) {
        if (entries.length > 1) {
          throw new Error(
            "Multiple HRMs are paired on CORE. Clear paired HRMs before pairing one ANT+ sensor.",
          );
        }
        if (entries.length === 1) {
          if (entries[0].antId === id) return finishStatus(entries);
          throw new Error(
            "A HRM is already paired on CORE. Clear paired HRM before pairing another ANT+ sensor.",
          );
        }
        return ble
          .writeControlPoint(
            protocol.OPCODES.HRM_PAIR_ANT,
            protocol.makeAntPairParams(id),
          )
          .then(function () {
            return queryEntries()
              .catch(function (err) {
                if (!isPairedCountTimeout(err)) throw err;
                return [makeSyntheticEntry(id, "Searching")];
              })
              .then(finishStatus);
          });
      });
  });
};

exports.ensureConfigured = function () {
  return withSession("configuring_ant", function () {
    return queryEntriesAllowTimeout().then(ensureConfiguredPairing).then(finishStatus);
  });
};

exports.clear = function () {
  return withSession("clearing", function () {
    return ble.writeControlPoint(protocol.OPCODES.HRM_CLEAR).then(function () {
      return queryEntriesAllowTimeout()
        .then(finishStatus);
    });
  });
};
