package com.exacth2o.lighting;

import com.sun.tools.attach.VirtualMachine;

public final class LightingAttach {
    private LightingAttach() {
    }

    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 3) {
            throw new IllegalArgumentException("Usage: LightingAttach <pid> <agent-jar> <properties-file>");
        }
        VirtualMachine machine = VirtualMachine.attach(arguments[0]);
        try {
            machine.loadAgent(arguments[1], arguments[2]);
        } finally {
            machine.detach();
        }
    }
}
