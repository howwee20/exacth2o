"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MachineState = void 0;
var MachineState;
(function (MachineState) {
    MachineState["STARTUP"] = "STARTUP";
    MachineState["RUNNING"] = "RUNNING";
    MachineState["STOPPED"] = "STOPPED";
    MachineState["UPDATE"] = "UPDATE";
    MachineState["RESET"] = "RESET";
})(MachineState || (exports.MachineState = MachineState = {}));
