var ble = require("coretemp.ble");
var protocol = require("coretemp.protocol");
var store = require("coretemp.store");

var managerState = "idle";
var lastError;
var lastStatus;

function isPairedCountTimeout(err) {
  return String(err).indexOf("opcode " + protocol.OPCODES.HRM_PAIRED_COUNT) >= 0;
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
    if (!current && (entries[i].stateText === "Synchronized" || entries[i].stateText === "Searching")) {
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
    currentSource: multiple ? null : (current || entries[0] || null),
    activeSource: multiple ? null : (active || null),
    connected: multiple ? false : !!active,
    syncState: multiple ? "multiple" : (active ? "synchronized" : (current ? "searching" : (entries.length ? "paired" : "none"))),
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
    return queryEntries().catch(function (err) {
      if (!isPairedCountTimeout(err)) throw err;
      return emptyUnknownEntries();
    }).then(finishStatus);
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
    return queryEntries().catch(function (err) {
      if (!isPairedCountTimeout(err)) throw err;
      return emptyUnknownEntries();
    }).then(function (entries) {
      if (entries.length > 1) {
        throw new Error("Multiple HRMs are paired on CORE. Clear paired HRMs before pairing one ANT+ sensor.");
      }
      if (entries.length === 1) {
        if (entries[0].antId === id) return finishStatus(entries);
        throw new Error("A HRM is already paired on CORE. Clear paired HRM before pairing another ANT+ sensor.");
      }
      return ble.writeControlPoint(
        protocol.OPCODES.HRM_PAIR_ANT,
        protocol.makeAntPairParams(id)
      ).then(function () {
        return queryEntries().catch(function (err) {
          if (!isPairedCountTimeout(err)) throw err;
          return [makeSyntheticEntry(id, "Searching")];
        }).then(finishStatus);
      });
    });
  });
};

exports.clear = function () {
  return withSession("clearing", function () {
    return ble.writeControlPoint(protocol.OPCODES.HRM_CLEAR).then(function () {
      return queryEntries().catch(function (err) {
        if (!isPairedCountTimeout(err)) throw err;
        return emptyUnknownEntries();
      }).then(finishStatus);
    });
  });
};
