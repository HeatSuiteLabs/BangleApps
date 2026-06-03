var ble = require("coretemp.ble");
var protocol = require("coretemp.protocol");
var store = require("coretemp.store");

var managerState = "idle";
var lastError;
var lastStatus;

function setState(nextState, reason) {
  managerState = nextState;
  if (reason !== undefined) store.log("HRM state -> " + nextState, reason);
  else store.log("HRM state -> " + nextState);
}

function buildStatus(entries) {
  var active;
  var current;
  var i;
  for (i = 0; i < entries.length; i++) {
    if (entries[i].stateText === "Synchronized" && !active) active = entries[i];
    if (!current && (entries[i].stateText === "Synchronized" || entries[i].stateText === "Searching")) {
      current = entries[i];
    }
  }
  return {
    managerState: managerState,
    paired: entries.length > 0,
    pairedCount: entries.length,
    pairedSensors: entries,
    transport: entries.length ? "ANT+" : null,
    currentSource: current || null,
    activeSource: active || null,
    connected: !!active,
    syncState: active ? "synchronized" : (current ? "searching" : (entries.length ? "paired" : "none")),
    lastError: lastError
  };
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
          ble.writeControlPoint(protocol.OPCODES.HRM_ENTRY, [index]).then(function (entryResponse) {
            entries.push(protocol.parseAntEntry(entryResponse, index));
          })
        );
      })(i);
    }
    return Promise.all(requests).then(function () {
      return entries.sort(function (a, b) {
        return a.index - b.index;
      });
    });
  });
}

function finishStatus(entries) {
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
  return ble.runWithConnectedSession("coretemp.hrm", fn).then(function (result) {
    return result;
  }, function (err) {
    return handleFailure(undefined, err);
  });
}

exports.init = function () {
  setState("idle");
};

exports.getManagerState = function () {
  return {
    state: managerState,
    lastError: lastError,
    lastStatus: lastStatus
  };
};

exports.getStatus = function () {
  return withSession("querying", function () {
    return queryEntries().then(finishStatus);
  });
};

exports.scanANT = function () {
  return withSession("scanning_ant", function () {
    return ble.writeControlPoint(protocol.OPCODES.HRM_SCAN_STOP, [], { expectResponse: false })
      .catch(function () { })
      .then(function () {
        return ble.writeControlPoint(protocol.OPCODES.HRM_SCAN_START, [0xFF], { expectResponse: false });
      })
      .then(function () {
        return new Promise(function (resolve) {
          setTimeout(resolve, 10000);
        });
      })
      .then(function () {
        return ble.writeControlPoint(protocol.OPCODES.HRM_SCAN_COUNT);
      })
      .then(function (response) {
        var count = protocol.parseCount(response);
        var found = [];
        var requests = [];
        var i;
        for (i = 0; i < count; i++) {
          (function (index) {
            requests.push(
              ble.writeControlPoint(protocol.OPCODES.HRM_SCAN_ENTRY, [index]).then(function (entryResponse) {
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
};

exports.pairANT = function (id) {
  return withSession("pairing_ant", function () {
    return ble.writeControlPoint(
      protocol.OPCODES.HRM_PAIR_ANT,
      protocol.makeAntPairParams(id)
    ).then(function () {
      return queryEntries().then(finishStatus);
    });
  });
};

exports.clear = function () {
  return withSession("clearing", function () {
    return ble.writeControlPoint(protocol.OPCODES.HRM_CLEAR).then(function () {
      return queryEntries().then(finishStatus);
    });
  });
};
