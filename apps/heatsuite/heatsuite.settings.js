(function (back) {

    var modHS = require('HSModule');
    var settingsJSON = "heatsuite.settings.json";
    var studyTasksJSON = "heatsuite.tasks.json";
    var BP_SERVICE_UUID = "1810";
    var BP_DATE_TIME_UUID = "2A08";

    function log() {
        if (!settings.DEBUG && !settings.SAVE_DEBUG) return;
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
        if (modHS.log) {
            modHS.log(parts.join(" "));
        } else {
            console.log(parts.join(" "));
        }
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

    function bufferToHex(buffer) {
        if (!buffer) return "";
        var arr = new Uint8Array(buffer);
        var bytes = [];
        for (var i = 0; i < arr.length; i++) bytes.push(byteToHex(arr[i]));
        return bytes.join(" ");
    }

    function getSecurityStatus(device) {
        if (!device || !device.getSecurityStatus) return {};
        try {
            return device.getSecurityStatus() || {};
        } catch (e) {
            log("[BP Pair] Security status failed", e);
            return {};
        }
    }

    function logSecurityStatus(label, device) {
        log(label, safeStringify(getSecurityStatus(device)));
    }

    function logScanDevice(type, device) {
        log("[Scan]", type, "id=" + device.id, "name=" + (device.name || ""), "rssi=" + device.rssi,
            "services=" + safeStringify(device.services || []),
            device.data ? "payload=" + bufferToHex(device.data) : "");
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

    function trySyncBPDeviceTime(device) {
        return device.getPrimaryService(BP_SERVICE_UUID).then(function (service) {
            return service.getCharacteristic(BP_DATE_TIME_UUID);
        }).then(function (characteristic) {
            return characteristic.writeValue(buildDateTimePayload(new Date())).then(function () {
                log("[BP Pair] Time sync complete");
                return true;
            });
        }).catch(function (e) {
            log("[BP Pair] Time sync skipped", e);
            return false;
        });
    }

    function writeSettings(key, value) {
        var s = require('Storage').readJSON(settingsJSON, true) || {};
        s[key] = value;
        require('Storage').writeJSON(settingsJSON, s);
        settings = readSettings();
        if (global.WIDGETS && WIDGETS["heatsuite"]) WIDGETS["heatsuite"].changed(); //redraw widget on settings update if open
    }

    function writeSettingsBatch(values) {
        var s = require('Storage').readJSON(settingsJSON, true) || {};
        Object.keys(values).forEach(function (key) {
            s[key] = values[key];
        });
        require('Storage').writeJSON(settingsJSON, s);
        settings = readSettings();
    }

    function getWidget() {
        return global.WIDGETS && WIDGETS["heatsuite"];
    }

    function stopBLEDevices() {
        var widget = getWidget();
        if (widget && widget.stopBLEDevices) return Promise.resolve(widget.stopBLEDevices());
        return Promise.resolve();
    }

    function startBLEDevices() {
        var widget = getWidget();
        if (widget && widget.startBLEDevices) return Promise.resolve(widget.startBLEDevices());
        return Promise.resolve();
    }

    function disconnectDevice(device) {
        if (!device || device.connected === false || !device.disconnect) return Promise.resolve();
        try {
            return Promise.resolve(device.disconnect()).catch(function (e) {
                log("[BLE] Disconnect failed", e);
            });
        } catch (e) {
            log("[BLE] Disconnect failed", e);
            return Promise.resolve();
        }
    }

    function readSettings() {
        var out = Object.assign(
            require('Storage').readJSON("heatsuite.default.json", true) || {},
            require('Storage').readJSON(settingsJSON, true) || {}
        );
        out.StudyTasks = require('Storage').readJSON(studyTasksJSON, true) || [];
        if (!Array.isArray(out.StudyTasks)) out.StudyTasks = [];
        return out;
    }
    var settings = readSettings();

    /*---- PAIRING FUNCTIONS FOR DEVICES ----*/
    function BPPair(id, name) {
        var device;
        var pairedName;
        function attachDisconnectLog() {
            if (!device || !device.device || device.device._hsBPDisconnectLog) return;
            device.device._hsBPDisconnectLog = true;
            device.device.on('gattserverdisconnected', function (reason) {
                log("[BP Pair] Disconnected", reason);
            });
        }
        function isBonded() {
            var security = getSecurityStatus(device);
            return !!(security && security.bonded);
        }
        function connect() {
            log("[BP Pair] Connect start", id, name || "");
            return NRF.connect(id).then(function (d) {
                device = d;
                attachDisconnectLog();
                log("[BP Pair] Connected", id);
                logSecurityStatus("[BP Pair] Security after connect", device);
                return new Promise(resolve => setTimeout(resolve, 2000));
            });
        }
        function savePairing() {
            var values = { "bt_bloodPressure_id": id };
            pairedName = name || device.name || (device.device && device.device.name);
            if (pairedName) values.bt_bloodPressure_name = pairedName;
            writeSettingsBatch(values);
            log("[BP Pair] Saved device id", id, pairedName || "");
        }
        function restoreBLEAndShowMenu(message, title, isError) {
            return startBLEDevices().catch(function (e) {
                log("[BLE] Restore failed", e);
                if (!isError) {
                    message = message + "\nBLE restore failed: " + e;
                    title = title || "BP Device";
                }
            }).then(function () {
                if (isError) {
                    return E.showAlert(message, title).then(function () { E.showMenu(deviceSettings()); });
                }
                return E.showPrompt(message, { title: title, buttons: { "OK": true } }).then(function () { E.showMenu(deviceSettings()); });
            });
        }
        E.showMessage(`Pairing with\n${id}`, "Pair BP");
        connect().then(function () {
            logSecurityStatus("[BP Pair] Security after settle", device);
            if (isBonded()) {
                log("[BP Pair] Already bonded");
                return true;
            } else if (device.startBonding) {
                log("[BP Pair] Start bonding");
                return device.startBonding().then(function (result) {
                    log("[BP Pair] Bonding resolved", result);
                    return result;
                });
            }
            throw new Error("Bonding is unavailable");
        }).then(function () {
            logSecurityStatus("[BP Pair] Security after bonding", device);
            if (!isBonded()) throw new Error("Pairing incomplete. Hold START until PR and try again.");
        }).then(function () {
            return trySyncBPDeviceTime(device);
        }).then(function () {
            return disconnectDevice(device);
        }).then(function () {
            savePairing();
            return restoreBLEAndShowMenu("Paired!", "BP Device", false);
        }).catch(function (e) {
            log("[BP Pair] Error", e);
            disconnectDevice(device).then(function () {
                return restoreBLEAndShowMenu("Error! " + e, "BP Device", true);
            });
        });
    }
    function PairTcore(id) {
        E.showMessage(`Pairing /n ${id}`, "Bluetooth");
        var gatt;
        NRF.connect(id).then(function (g) {
            gatt = g;
            console.log("connected!!!");
            //  return gatt.startBonding();
            //}).then(function() {
            console.log("bonded", gatt.getSecurityStatus());
            writeSettings("bt_coreTemperature_id", id);
            E.showAlert("Paired!").then(function () { startBLEDevices().then(function () { E.showMenu(deviceSettings()); }); });
            log("Device ID paired, Done!");
            return gatt.disconnect();
        }).catch(function (e) {
            log("ERROR: " + e);
            E.showAlert("error! " + e).then(function () { startBLEDevices().then(function () { E.showMenu(deviceSettings()); }); });
        });
    }

    function deviceSettings() {
        var menu = { '< Back': function () { E.showMenu(mainMenuSettings()); } };
        menu[''] = { 'title': 'Devices' };
        settings.StudyTasks.forEach(task => {
            if (task.btPair === undefined || !task.btPair) return;
            let key = task.id; // Adjust based on how you identify tasks
            let id = "bt_" + key + "_id";
            if (settings[id] !== undefined) {
                menu["Clear " + key] = function () {
                    E.showPrompt("Clear " + key + " device?").then((r) => {
                        if (r) {
                            writeSettings("bt_" + key + "_id", undefined);
                            writeSettings("bt_" + key + "_name", undefined);
                        }
                        E.showMenu(mainMenuSettings());
                    });
                };
            } else {
                menu["Pair " + key] = () => createMenuFromScan(key, task.btInfo.service);
            }
        });
        return menu;
    }

    function recordMenu(){
      settings = readSettings();
      function updateRecorder(name, v){
        var r = settings.record;
        r = r.filter(item => item !== name);
        if (v) r.push(name);
        settings.record = r;
        writeSettings("record", r);
      }

      var menu = { '< Back': function () { E.showMenu(mainMenuSettings()); } };
      menu[''] = { 'title': 'Recorder' };

      var recorderOptions = {
        'hrm' : 'Optical HR',
        'steps' : "Steps",
        'bat' : 'Battery',
        'movement': 'Movement',
        'acc':'Accelerometry',
        'baro':'Temp/Pressure',
        'bthrm': 'BT HRM',
        'CORESensor':'CORE Sensor'
      };

      Object.keys(recorderOptions).forEach(function(k){
        var name = recorderOptions[k];
        menu[name] = {
          value: settings.record.includes(k),
          onchange: updateRecorder.bind(null, String(k))
        };
      });

      menu['High Acc'] = {
        value: settings.highAcc || false,
        onchange: function(v){
          settings.highAcc = v;
          writeSettings("highAcc", v);
        }
      };

      return menu;
    }

    function mainMenuSettings() {
        settings = readSettings();
        var menu = {
            '': { 'title': 'Main' },
            '< Back': back
        };
        
        menu['Recorders'] = function () {E.showMenu(recordMenu()) };
        menu['Devices'] = function () { E.showMenu(deviceSettings()) };
        menu['GPS'] = function () { E.showMenu(gpsSettings()) };
        menu['Language'] = function () { E.showMenu(languageMenu()) };
        menu['Swipe Launch'] = {
            value: settings.swipeOpen || false,
            onchange: v => {
                settings.swipeOpen = v;
                writeSettings("swipeOpen", v);
            }
        };
        if(settings.highAcc != undefined && settings.highAcc){
            menu['High Acc'] = function () { E.showMenu(HighAccSettings()) };
        }
        menu['Survey Random'] = {
            value: settings.surveyRandomize || false,
            onchange: v => {
                settings.GPS = v;
                writeSettings("surveyRandomize", v);
            }
        };
        menu['HRM Interval'] = {
            value: settings.HRMInterval || 0,
            min: 0, max: 60,
            onchange: v => {
                settings.HRMInterval = v;
                writeSettings("HRMInterval", v);
            }
        };
        menu['Restart BLE'] = function () {
            E.showPrompt("Restart Bluetooth?").then((r) => {
                if (r) {
                    NRF.disconnect()
                    NRF.restart();
                }
                E.showMenu(mainMenuSettings());
            });
        };
        menu['Clear Cache'] = function () {
            E.showPrompt("Clear Cache?").then((r) => {
                if (r) {
                    require('Storage').writeJSON("heatsuite.cache.json", {});
                }
                E.showMenu(mainMenuSettings());
            });
        }
        menu['Clear Study ID'] = function () {
            E.showPrompt("Clear study ID (includes ignored)?").then((r) => {
                if (r) {
                    writeSettings("studyID", undefined);
                    writeSettings("studyIDIgnore", []);
                }
                E.showMenu(mainMenuSettings());
            });
        }
        menu['Notifications'] = {
            value: settings.notifications || false,
            onchange: v => {
                settings.notifications = v;
                writeSettings("notifications", v);
            }
        };
        menu['Debug'] = function () { E.showMenu(debugMenu()) };
        return menu;
    }
    function debugMenu(){
        var menu = {
            '': { 'title': 'Debug' },
            '< Back': function () { E.showMenu(mainMenuSettings()); }
        }; 
        menu['Console'] = {
            value: settings.DEBUG || false,
            onchange: v => {
                settings.DEBUG = v;
            writeSettings("DEBUG", v);
            }
        };
        menu['Log (file)'] = {
            value: settings.SAVE_DEBUG || false,
            onchange: v => {
                settings.SAVE_DEBUG = v;
                writeSettings("SAVE_DEBUG", v);
            }
        };
        return menu;
    }
    function HighAccSettings(){
        var menu = {
            '': { 'title': 'High Acc' },
            '< Back': function () { E.showMenu(mainMenuSettings()); }
        }; 
        menu['Interval'] = {
            value: settings.AccLogInt || 5,
            min: 1, max: 60,
            onchange: v => {
                settings.AccLogInt = v;
                writeSettings("AccLogInt", v);
            }
        };
        menu['Rec/File'] = {
            value: settings.BinMaxRecords || 6000,
            min: 100, max: 12000, step: 100,
            onchange: v => {
                settings.BinMaxRecords = v;
                writeSettings("BinMaxRecords", v);
            }
        };
        return menu;
    }
    function gpsSettings() {
        var menu = {
            '': { 'title': 'GPS' },
            '< Back': function () { E.showMenu(mainMenuSettings()); }
        };
        menu['GPS'] = {
            value: settings.GPS || false,
            onchange: v => {
                settings.GPS = v;
                writeSettings("GPS", v);
            }
        };
        menu['Scan Time (min)'] = {
            value: settings.GPSScanTime || 1,
            min: 0, max: 60,
            onchange: v => {
                settings.GPSScanTime = v;
                writeSettings("GPSScanTime", v);
            }
        };
        menu['Interval (min)'] = {
            value: settings.GPSInterval || 10,
            min: 0, max: 180,
            onchange: v => {
                settings.GPSInterval = v;
                writeSettings("GPSInterval", v);
            }
        };
        menu['Adaptive (min)'] = {
            value: settings.GPSAdaptiveTime || 2,
            min: 0, max: 60,
            onchange: v => {
                settings.GPSAdaptiveTime = v;
                writeSettings("GPSAdaptiveTime", v);
            }
        };
        return menu;
    }

    function languageMenu() {
        var menu = { '< Back': function () { E.showMenu(mainMenuSettings()); } };
        menu[''] = { 'title': 'Language' };
        var surveySettings = require('Storage').readJSON("heatsuite.survey.json", true) || {};

        Object.keys(surveySettings.supported).forEach(key => {
            //var id = surveySettings.supported[key];
            menu[key] = function () {
                E.showPrompt("Set " + key + "?").then((r) => {
                    if (r) {
                        writeSettings('lang', key);
                    }
                    E.showMenu(mainMenuSettings());
                });
            };
        });
        return menu;
    }

    function createMenuFromScan(type, service) {
        E.showMenu();
        E.showMessage("Scanning for 4 seconds");
        var submenu_scan = {
            '< Back': function () { startBLEDevices(); E.showMenu(deviceSettings()); }
        };
        function startScan() {
            NRF.findDevices(function (devices) {
                submenu_scan[''] = { title: `Scan (${devices.length} found)` };
                if (devices.length === 0) {
                    E.showAlert("No " + type + " devices found")
                        .then(() => { startBLEDevices(); E.showMenu(deviceSettings()); });
                    return;
                } else {
                    devices.forEach((d) => {
                        logScanDevice(type, d);
                        var shown = (d.name || d.id.substr(0, 17));
                        submenu_scan[shown] = function () {
                            E.showPrompt("Set " + shown + "?").then((r) => {
                                if (r) {
                                    switch (type) {
                                        case "bloodPressure":
                                            BPPair(d.id, d.name);
                                            break;
                                        case "coreTemperature":
                                            PairTcore(d.id);
                                            break;
                                        default:
                                            startBLEDevices();
                                            E.showMenu(deviceSettings());
                                            break;
                                    }
                                } else {
                                    startBLEDevices();
                                    E.showMenu(deviceSettings());
                                }
                            });
                        };
                    });
                }
                E.showMenu(submenu_scan);
            }, { timeout: 4000, active: true, filters: [{ services: [service] }] });
        }
        stopBLEDevices().then(function () {
            startScan();
        }).catch(function (e) {
            log("[BLE preflight] failed before settings scan", e);
            startBLEDevices().catch(function (restoreError) {
                log("[BLE] Restore after scan preflight failed", restoreError);
            }).then(function () {
                return E.showAlert("Bluetooth stop failed: " + e, "Scan Error");
            })
                .then(function () { E.showMenu(deviceSettings()); });
        });
    }
    
    E.showMenu(mainMenuSettings());
})
