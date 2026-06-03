var ble = require("coretemp.ble");
var protocol = require("coretemp.protocol");
var store = require("coretemp.store");

var managerState = "idle";
var lastError;
var lastStatus;

var HRM_CONFIG_FILE = "coretemp.hrm.json";

function isPairAntTimeout(err) {
  return (
    String(err).indexOf("opcode " + protocol.OPCODES.HRM_PAIR_ANT) >= 0
  );
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
    valid: valid,
  };
}

function setState(nextState, reason) {
  managerState = nextState;
  if (reason !== undefined) store.log("HRM state -> " + nextState, reason);
  else store.log("HRM state -> " + nextState);
}

function buildStatus(config, sent) {
  config = config || readConfiguredHRM();
  return {
    managerState: managerState,
    configuredTransport: config.transport,
    configuredAntId: config.antId,
    configuredAutoConnect: config.autoConnect,
    configuredValid: config.valid,
    lastSent: !!sent,
    lastError: lastError,
  };
}

function finishStatus(config, sent) {
  lastError = undefined;
  setState("idle");
  lastStatus = buildStatus(config, sent);
  return lastStatus;
}

function handleFailure(err, config) {
  lastError = String(err);
  setState("error", lastError);
  lastStatus = buildStatus(config, false);
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
    },
  );
}

exports.init = function () {
  setState("idle");
  lastStatus = buildStatus();
};

exports.getManagerState = function () {
  return {
    state: managerState,
    lastError: lastError,
    lastStatus: lastStatus,
  };
};

exports.getStatus = function () {
  lastStatus = buildStatus();
  return Promise.resolve(lastStatus);
};

exports.ensureConfigured = function () {
  var config = readConfiguredHRM();

  if (!config.valid || config.autoConnect === false) {
    lastStatus = buildStatus(config, false);
    return Promise.resolve(lastStatus);
  }

  return withSession("configuring_ant", config, function () {
    store.log("Sending configured ANT+ HRM id", config.antId);
    return ble
      .writeControlPoint(
        protocol.OPCODES.HRM_PAIR_ANT,
        protocol.makeAntPairParams(config.antId),
      )
      .catch(function (err) {
        if (isPairAntTimeout(err)) {
          throw new Error(
            "Timed out waiting for CORE control point response 0x80 for HRM pair opcode",
          );
        }
        throw err;
      })
      .then(function () {
        return finishStatus(config, true);
      });
  });
};
