package PhenoSystemControl.control.io;

/** Harness stand-in for the legacy BEAGLE controller's static Control API. */
public final class Control {
    private static volatile double intensity = 0;

    private Control() {
    }

    public static double getIntensity() {
        return intensity;
    }

    public static void setIntensity(double value) {
        intensity = value;
    }

    public static void update() {
        // The real controller writes the FPGA here; the harness has no hardware.
    }
}
