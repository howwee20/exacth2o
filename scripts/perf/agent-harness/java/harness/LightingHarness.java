package harness;

/**
 * Starts the unmodified LightingAgentV2 exactly as the attach watcher does
 * (agentmain with the properties path) and keeps the JVM alive for the run.
 */
public final class LightingHarness {
    private LightingHarness() {
    }

    public static void main(String[] args) throws Exception {
        com.exacth2o.lighting.LightingAgentV2.agentmain(args[0], null);
        Thread.sleep(Long.parseLong(args[1]) * 1000L);
    }
}
