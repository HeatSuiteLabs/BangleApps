{
let studyTasksJSON = "heatsuite.tasks.json";
let studyTasks = require('Storage').readJSON(studyTasksJSON, true) || [];
if (!Array.isArray(studyTasks)) studyTasks = [];

let Layout = require("Layout");
let modHS = require("HSModule");
let layout;
let NRFFindDeviceTimeout, TaskScreenTimeout;

let settings = modHS.getSettings();

let appCache = modHS.getCache();

function stopBLEDevices() {
  if (global.WIDGETS && WIDGETS["heatsuite"] && WIDGETS["heatsuite"].stopBLEDevices) {
    return Promise.resolve(WIDGETS["heatsuite"].stopBLEDevices());
  }
  return Promise.resolve();
}

function loadTaskApp(appFile, label) {
  NRF.setScan();
  stopBLEDevices().then(function () {
    NRF.setScan();
    Bangle.load(appFile);
  }).catch(function (e) {
    modHS.log("Failed to stop BLE before " + label + " task: " + e);
    Bangle.load(appFile);
  });
}

function loadBPTaskApp() {
  loadTaskApp('heatsuite.bp.js', "BP");
}

function queueNRFFindDeviceTimeout() {
  if (NRFFindDeviceTimeout) clearTimeout(NRFFindDeviceTimeout);
  NRFFindDeviceTimeout = setTimeout(function () {
    NRFFindDeviceTimeout = undefined;
    findBtDevices();
  }, 3000);
}

function findBtDevices() {
  NRF.setScan(); //clear any scans running!
  NRF.findDevices(function (devices) {
    let found = false;
    function foundDevice(label, appFile) {
      found = true;
      if (layout && layout.msg) {
        layout.msg.label = label + " Found";
        layout.render();
      }
      if (NRFFindDeviceTimeout) clearTimeout(NRFFindDeviceTimeout);
      if (TaskScreenTimeout) clearTimeout(TaskScreenTimeout);
      NRF.setScan();
      loadTaskApp(appFile, label);
      return true;
    }
    if (devices.length !== 0) {
      devices.some((d) => {
        modHS.log("Found device", d);
        let services = d.services;
        modHS.log("Services: ", services);
        if (services !== undefined && services.includes('1810') && d.id === settings.bt_bloodPressure_id) {
          //Blood Pressure
          found = true;
          if (layout && layout.msg) {
            layout.msg.label = "BP Found";
            layout.render();
          }
          if (NRFFindDeviceTimeout) clearTimeout(NRFFindDeviceTimeout);
          loadBPTaskApp();
          return true;
        } else if (services !== undefined && (services.includes('181b') || services.includes('181d')) && studyTasks.some(task => task.id === "bodyMass")) {
          if (services.includes('181b')) {
            if (!d.serviceData || !d.serviceData['181b'] || d.serviceData['181b'].length < 2) {
              modHS.log("Scale service found, no V2 service data");
              return false;
            }
            let data = d.serviceData['181b'];
            let ctlByte = data[1];
            let weightRemoved = ctlByte & (1 << 7);
            modHS.log(weightRemoved);
            if (weightRemoved !== 0) {
              modHS.log("No weight on scale");
              return false;
            }
          } else if (services.includes('181d')) {
            if (!d.serviceData || !d.serviceData['181d'] || d.serviceData['181d'].length < 3) {
              modHS.log("Scale service found, no V1 service data");
              return false;
            }
            let data = d.serviceData['181d'];
            let unitByte = data[0] & 0x3F;
            let raw = (data[2] << 8) + data[1];
            let mass = raw * 0.01;
            if (unitByte === 0x22) {
              mass = mass / 2;
            } else if (unitByte !== 0x03 && unitByte !== 0x12) {
              modHS.log("Unknown V1 scale unit");
              return false;
            }
            if (mass <= 0) {
              modHS.log("No weight on V1 scale");
              return false;
            }
          }
            //Mass found
            return foundDevice("Scale", 'heatsuite.mass.js');
        } else if (services !== undefined && services.includes('1809') && d.id === settings.bt_coreTemperature_id) {
          //Core Temperature
          return foundDevice("Temp", 'heatsuite.bletemp.js');
        }
      });
    }
    if (!found) {
      modHS.log("Search Complete, No Devices Found");
      queueNRFFindDeviceTimeout();
    } else {
      if (TaskScreenTimeout) clearTimeout(TaskScreenTimeout);
      if (NRFFindDeviceTimeout) clearTimeout(NRFFindDeviceTimeout);
    }
  }, { timeout: 1000, active: true});
}

function taskButtonInterpretter(string) {
  //turn off FindDeviceHandler whenever we navigate off task screen
  if (NRFFindDeviceTimeout) clearTimeout(NRFFindDeviceTimeout);
  return eval(string);
}

function queueTaskScreenTimeout() {
  if (TaskScreenTimeout) clearTimeout(TaskScreenTimeout);
  TaskScreenTimeout = setTimeout(function () {
    if (NRFFindDeviceTimeout) clearTimeout(NRFFindDeviceTimeout);
    Bangle.load();
  }, 180000);
}

function draw() {
  let btRequired = false;
  g.clear();
  g.reset();
  if (studyTasks.length === 0) {
    if(require("Storage").read("heatsuite.survey.json") !== undefined){ //likely just using for EMA survey
      return Bangle.load('heatsuite.survey.js'); //go right to survey!
    }
    modHS.log('No Study Tasks loaded...');
    layout = new Layout({
      type: "v",
      c: [
        {
          type: "txt",
          font: "Vector:30",
          label: "No Study Tasks Loaded.",
          wrap: true,
          fillx: 1,
          filly: 1
        }
      ]
    });
    layout.render();
    return;
  }
  let taskArr = appCache.taskQueue;
  let taskID = [];
  if (taskArr !== undefined) {
    taskID = taskArr.filter(function (taskArr) {
      return taskArr.id;
    }).map(function (taskArr) {
      return taskArr.id;
    });
  }
  let layoutOut = { type: "v", c: [] };
  let row = { type: "h", c: [] };
  let rowCount = 2;
  if( studyTasks.length > 4){
    rowCount = 3; //so we can include up to 9 tasks on the screen at once
  }
  studyTasks.forEach(task => {
    let btn = { type: "btn", fillx: 1, filly: 1 };
    btn.id = task.id;
    btn.src = eval(task.icon);
    //callback on button press
    if (task.cbBtn) {
      btn.cb = l => taskButtonInterpretter(task.cbBtn);
    }
    //back color determination
    btn.btnFaceCol = "#90EE90";
    //a to do!!
    if (taskID.includes(task.id)) {
      btn.btnFaceCol = "#FFFF00";
    }
    //no bt paired
    if (task.btPair === true) {
      if (settings["bt_" + task.id + "_id"] === undefined || !settings["bt_" + task.id + "_id"]) {
        //make it clickable so we can go to settings and pair something
        btn.btnFaceCol = "#FF0000";
        btn.cb = l => eval(require("Storage").read("heatsuite.settings.js"))(()=>load("heatsuite.app.js"));
      }
    }
    if(task.btInfo !== undefined){
      btRequired = true;//we will be scanning for bluetooth devices
    }
    //builder for each icon in taskScreen
    if (row.c.length >= rowCount) {
      layoutOut.c.push(row);
      row = { type: "h", c: [] };
    }
    row.c.push(btn);
  });
  //push that last row in if needed
  if (row.c.length > 0) {
    layoutOut.c.push(row);
  }
  //Final 
  if(btRequired) layoutOut.c.push({ type: "txt", font: "6x8:2", label: "Searching...", id: "msg", fillx: 1 });
  let options = { 
    lazy: true,
    btns:[{label:"Exit", cb: l=>Bangle.showClock() }]
  };
  
  layout = new Layout(layoutOut, options);
  layout.render();
  if(btRequired) queueNRFFindDeviceTimeout();
  queueTaskScreenTimeout();
}

Bangle.setLocked(false); //unlock screen!

draw();
E.on('kill', function(){
      NRF.setScan(); //clear scan
      if (TaskScreenTimeout) clearTimeout(TaskScreenTimeout);
      if (NRFFindDeviceTimeout) clearTimeout(NRFFindDeviceTimeout);
      NRFFindDeviceTimeout = undefined;
      TaskScreenTimeout = undefined;
});
}
