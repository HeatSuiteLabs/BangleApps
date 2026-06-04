var protocol = require("coretemp.protocol");

var adapter;
var activeRequest;
var queue = Promise.resolve();

function log(text, value) {
  if (adapter && adapter.log) adapter.log(text, value);
}

function normalizeOptions(options) {
  if (typeof options === "number") return { timeoutMs: options };
  return options || {};
}

function clearRequest(req) {
  if (req.timeout) clearTimeout(req.timeout);
  if (activeRequest === req) activeRequest = undefined;
}

function writeBytes(bytes) {
  if (!adapter || !adapter.write) {
    return Promise.reject(new Error("CORE control point is not connected"));
  }
  return Promise.resolve(adapter.write(bytes));
}

exports.setAdapter = function (nextAdapter) {
  adapter = nextAdapter;
  if (!adapter) exports.cancelActive("CORE control point is not connected");
};

exports.isBusy = function () {
  return !!activeRequest;
};

exports.cancelActive = function (reason) {
  var req = activeRequest;
  if (!req) return;
  clearRequest(req);
  req.reject(new Error(reason || "CORE control point request cancelled"));
};

exports.request = function (opcode, params, options) {
  params = params || [];
  options = normalizeOptions(options);
  queue = queue.catch(function () { }).then(function () {
    return new Promise(function (resolve, reject) {
      var req = {
        opcode: opcode,
        params: params.slice ? params.slice() : [],
        resolve: resolve,
        reject: reject
      };
      var bytes = [opcode].concat(req.params);

      activeRequest = req;
      req.timeout = setTimeout(function () {
        if (activeRequest !== req) return;
        clearRequest(req);
        reject(new Error("CORE control point timeout for opcode " + opcode));
      }, options.timeoutMs || 10000);

      writeBytes(bytes).then(function () {
        log("Sent control point opcode", opcode);
      }).catch(function (err) {
        if (activeRequest !== req) return;
        clearRequest(req);
        reject(err);
      });
    });
  });
  return queue;
};

exports.onNotification = function (dv) {
  var response = protocol.parseResponse(dv);
  var req;

  if (response.opCode !== protocol.OPCODES.RESPONSE) {
    log("Ignoring non-control point response", response.bytes);
    return;
  }
  if (!activeRequest) {
    log("Discarding stale control point response", response.bytes);
    return;
  }
  if (response.requestOpCode !== activeRequest.opcode) {
    log("Discarding mismatched control point response", {
      expected: activeRequest.opcode,
      bytes: response.bytes
    });
    return;
  }

  req = activeRequest;
  clearRequest(req);
  if (response.resultCode === 0x01) {
    req.resolve(response);
  } else {
    req.reject(new Error("Control point error code " + response.resultCode));
  }
};
