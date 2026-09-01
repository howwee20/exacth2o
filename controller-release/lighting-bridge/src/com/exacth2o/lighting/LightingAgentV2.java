package com.exacth2o.lighting;

import java.awt.Window;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Properties;
import java.util.TimeZone;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.swing.JCheckBox;
import javax.swing.JSlider;
import javax.swing.JTextField;
import javax.swing.SwingUtilities;

/**
 * Versioned hot-upgrade agent for the legacy chamber controller.
 *
 * The original bridge class may already be loaded in the controller JVM, so a
 * new Agent-Class name is required to install this release without restarting
 * or rebuilding the legacy application. In addition to the existing Control
 * API bridge, this release mirrors authoritative controller changes into an
 * open MaintenanceGUI on Swing's event-dispatch thread.
 */
public final class LightingAgentV2 {
    private static final String VERSION = "exacth2o-lighting-bridge-2.0.0";
    private static final String MAINTENANCE_GUI = "PhenoSystemControl.gui.MaintenanceGUI";
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);

    private LightingAgentV2() {
    }

    public static void premain(String arguments, Instrumentation instrumentation) {
        start(arguments);
    }

    public static void agentmain(String arguments, Instrumentation instrumentation) {
        start(arguments);
    }

    private static void start(String arguments) {
        if (!RUNNING.compareAndSet(false, true)) return;
        if (arguments == null || arguments.trim().length() == 0) {
            RUNNING.set(false);
            return;
        }
        System.setProperty("https.protocols", "TLSv1.2");
        Thread bridge = new Thread(new Bridge(new File(arguments.trim())), "ExactH2O-Lighting-Bridge-V2");
        bridge.setDaemon(true);
        bridge.start();
    }

    private static final class Bridge implements Runnable {
        private final File configurationFile;
        private Method getIntensity;
        private Method setIntensity;
        private Method update;
        private String processStartedAt;
        private int processId;
        private int maintenanceWindowIdentity;
        private double lastObservedIntensity = Double.NaN;

        Bridge(File configurationFile) {
            this.configurationFile = configurationFile;
        }

        public void run() {
            try {
                bindController();
                log("Bridge V2 attached to the existing PhenoSystemControl Control API.");
                while (true) {
                    Properties configuration = loadConfiguration();
                    if (!Boolean.parseBoolean(configuration.getProperty("enabled", "true"))) {
                        log("Bridge V2 disabled by configuration.");
                        return;
                    }

                    long pollMs = parseLong(configuration.getProperty("poll_ms"), 1000L, 500L, 10000L);
                    try {
                        double controllerIntensity = readControllerIntensity();
                        boolean controllerChanged = Double.compare(lastObservedIntensity, controllerIntensity) != 0;
                        synchronizeMaintenanceScreen(controllerIntensity, controllerChanged);
                        lastObservedIntensity = controllerIntensity;

                        String syncResponse = post(configuration, syncPayload(configuration, controllerIntensity));
                        Command command = parseCommand(syncResponse);
                        if (command != null) applyCommand(configuration, command);
                    } catch (Throwable error) {
                        log("Synchronization retry: " + rootMessage(error));
                    }
                    Thread.sleep(pollMs);
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                log("Bridge V2 stopped.");
            } catch (Throwable fatal) {
                log("Bridge V2 stopped: " + rootMessage(fatal));
            } finally {
                RUNNING.set(false);
            }
        }

        private void bindController() throws Exception {
            ClassLoader loader = ClassLoader.getSystemClassLoader();
            Class<?> control = Class.forName("PhenoSystemControl.control.io.Control", true, loader);
            getIntensity = control.getMethod("getIntensity", new Class<?>[0]);
            setIntensity = control.getMethod("setIntensity", new Class<?>[]{Double.TYPE});
            update = control.getMethod("update", new Class<?>[0]);

            long startedAt = ManagementFactory.getRuntimeMXBean().getStartTime();
            processStartedAt = isoTime(new Date(startedAt));
            String runtimeName = ManagementFactory.getRuntimeMXBean().getName();
            int separator = runtimeName.indexOf('@');
            processId = Integer.parseInt(separator < 0 ? runtimeName : runtimeName.substring(0, separator));
        }

        private Properties loadConfiguration() throws Exception {
            Properties properties = new Properties();
            InputStream input = new FileInputStream(configurationFile);
            try {
                properties.load(input);
            } finally {
                input.close();
            }
            require(properties, "endpoint");
            require(properties, "device_token");
            return properties;
        }

        private String syncPayload(Properties configuration, double controllerIntensity) {
            return "{" +
                "\"action\":\"sync\"," +
                "\"bridge_ready\":" + Boolean.parseBoolean(configuration.getProperty("bridge_ready", "false")) + "," +
                "\"bridge_version\":\"" + VERSION + "\"," +
                "\"controller_intensity\":" + jsonNumber(controllerIntensity) + "," +
                "\"controller_process_id\":" + processId + "," +
                "\"controller_process_started_at\":\"" + processStartedAt + "\"" +
                "}";
        }

        private void applyCommand(Properties configuration, Command command) {
            boolean success = false;
            String errorMessage = null;
            double controllerIntensity;
            try {
                setIntensity.invoke(null, new Object[]{Double.valueOf(command.intensity)});
                update.invoke(null, new Object[0]);
                controllerIntensity = readControllerIntensity();
                success = Double.compare(controllerIntensity, command.intensity) == 0;
                if (success) {
                    synchronizeMaintenanceScreen(controllerIntensity, true);
                    lastObservedIntensity = controllerIntensity;
                } else {
                    errorMessage = "Control.getIntensity did not retain the requested value";
                }
            } catch (Throwable error) {
                controllerIntensity = safeReadControllerIntensity();
                errorMessage = rootMessage(error);
            }

            String payload = "{" +
                "\"action\":\"result\"," +
                "\"command_id\":\"" + jsonEscape(command.id) + "\"," +
                "\"success\":" + success + "," +
                "\"controller_intensity\":" + jsonNumber(controllerIntensity) + "," +
                "\"error_message\":" + (errorMessage == null ? "null" : "\"" + jsonEscape(errorMessage) + "\"") +
                "}";
            try {
                post(configuration, payload);
                log(success
                    ? "Portal intensity " + jsonNumber(command.intensity) + " applied and mirrored into the maintenance screen."
                    : "Portal command failed: " + errorMessage);
            } catch (Throwable resultError) {
                log("Unable to send command receipt: " + rootMessage(resultError));
            }
        }

        /**
         * Mirrors controller truth into a newly opened or currently visible
         * maintenance window. A local uncommitted draft is left alone until the
         * controller actually changes, while portal/timeline changes are shown
         * immediately. Programmatic Swing updates do not press Execute and do
         * not send a second hardware command.
         */
        private void synchronizeMaintenanceScreen(final double intensity, final boolean controllerChanged) {
            final Throwable[] failure = new Throwable[1];
            Runnable synchronize = new Runnable() {
                public void run() {
                    try {
                        Window maintenance = findMaintenanceWindow();
                        if (maintenance == null) {
                            maintenanceWindowIdentity = 0;
                            return;
                        }

                        int identity = System.identityHashCode(maintenance);
                        if (!controllerChanged && identity == maintenanceWindowIdentity) return;

                        int displayedIntensity = (int) Math.round(intensity);
                        JCheckBox enabled = (JCheckBox) field(maintenance, "jCheckBox_IntensitySet").get(maintenance);
                        JSlider slider = (JSlider) field(maintenance, "jSlider_IntensitySet").get(maintenance);
                        JTextField text = (JTextField) field(maintenance, "jTextField_IntensitySet").get(maintenance);
                        Field localIntensity = field(maintenance, "jIntensity");

                        if (displayedIntensity > 0) slider.setValue(displayedIntensity);
                        enabled.setSelected(displayedIntensity > 0);
                        text.setText(Integer.toString(displayedIntensity));
                        localIntensity.setInt(maintenance, displayedIntensity);
                        maintenance.revalidate();
                        maintenance.repaint();
                        maintenanceWindowIdentity = identity;
                    } catch (Throwable error) {
                        failure[0] = error;
                    }
                }
            };

            try {
                if (SwingUtilities.isEventDispatchThread()) {
                    synchronize.run();
                } else {
                    SwingUtilities.invokeAndWait(synchronize);
                }
                if (failure[0] != null) log("Maintenance screen synchronization retry: " + rootMessage(failure[0]));
            } catch (Throwable error) {
                log("Maintenance screen synchronization retry: " + rootMessage(error));
            }
        }

        private Window findMaintenanceWindow() {
            Window[] windows = Window.getWindows();
            for (int index = 0; index < windows.length; index++) {
                Window candidate = windows[index];
                if (candidate != null && candidate.isDisplayable()
                    && MAINTENANCE_GUI.equals(candidate.getClass().getName())) {
                    return candidate;
                }
            }
            return null;
        }

        private Field field(Object target, String name) throws Exception {
            Field value = target.getClass().getDeclaredField(name);
            value.setAccessible(true);
            return value;
        }

        private double readControllerIntensity() throws Exception {
            Object value = getIntensity.invoke(null, new Object[0]);
            return ((Number) value).doubleValue();
        }

        private double safeReadControllerIntensity() {
            try {
                return readControllerIntensity();
            } catch (Throwable ignored) {
                return 0;
            }
        }

        private String post(Properties configuration, String payload) throws Exception {
            URL endpoint = new URL(configuration.getProperty("endpoint"));
            HttpURLConnection connection = (HttpURLConnection) endpoint.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(12000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("X-Device-Token", configuration.getProperty("device_token"));

            byte[] body = payload.getBytes(UTF8);
            connection.setFixedLengthStreamingMode(body.length);
            OutputStream output = connection.getOutputStream();
            try {
                output.write(body);
            } finally {
                output.close();
            }

            int status = connection.getResponseCode();
            InputStream input = status >= 200 && status < 300
                ? connection.getInputStream()
                : connection.getErrorStream();
            String responseBody = readAll(input);
            connection.disconnect();
            if (status < 200 || status >= 300) {
                throw new IllegalStateException("HTTP " + status + ": " + responseBody);
            }
            return responseBody;
        }

        private void log(String message) {
            try {
                Properties properties = new Properties();
                if (configurationFile.isFile()) {
                    InputStream input = new FileInputStream(configurationFile);
                    try {
                        properties.load(input);
                    } finally {
                        input.close();
                    }
                }
                File logFile = new File(properties.getProperty(
                    "log_path",
                    new File(configurationFile.getParentFile(), "lighting-agent-v2.log").getAbsolutePath()
                ));
                File parent = logFile.getParentFile();
                if (parent != null) parent.mkdirs();
                OutputStream output = new FileOutputStream(logFile, true);
                try {
                    output.write((isoTime(new Date()) + " " + message + System.lineSeparator()).getBytes(UTF8));
                } finally {
                    output.close();
                }
            } catch (Throwable ignored) {
                // Logging must never affect the running chamber controller.
            }
        }
    }

    private static final class Command {
        final String id;
        final double intensity;

        Command(String id, double intensity) {
            this.id = id;
            this.intensity = intensity;
        }
    }

    private static Command parseCommand(String json) {
        int marker = json.indexOf("\"command\"");
        if (marker < 0) return null;
        int objectStart = json.indexOf('{', marker);
        int nullStart = json.indexOf("null", marker);
        if (nullStart >= 0 && (objectStart < 0 || nullStart < objectStart)) return null;
        if (objectStart < 0) return null;
        int objectEnd = json.indexOf('}', objectStart);
        if (objectEnd < 0) return null;
        String commandJson = json.substring(objectStart, objectEnd + 1);

        Matcher id = Pattern.compile("\\\"id\\\"\\s*:\\s*\\\"([0-9a-fA-F-]{36})\\\"").matcher(commandJson);
        Matcher intensity = Pattern.compile("\\\"intensity\\\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)").matcher(commandJson);
        if (!id.find() || !intensity.find()) return null;
        return new Command(id.group(1), Double.parseDouble(intensity.group(1)));
    }

    private static String readAll(InputStream input) throws Exception {
        if (input == null) return "";
        BufferedReader reader = new BufferedReader(new InputStreamReader(input, UTF8));
        try {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
            return builder.toString();
        } finally {
            reader.close();
        }
    }

    private static String require(Properties properties, String key) {
        String value = properties.getProperty(key);
        if (value == null || value.trim().length() == 0) {
            throw new IllegalArgumentException("Missing configuration: " + key);
        }
        return value.trim();
    }

    private static long parseLong(String value, long fallback, long minimum, long maximum) {
        try {
            long parsed = Long.parseLong(value);
            return Math.max(minimum, Math.min(maximum, parsed));
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static String jsonNumber(double value) {
        return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }

    private static String jsonEscape(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", "\\r")
            .replace("\n", "\\n");
    }

    private static String isoTime(Date value) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(value);
    }

    private static String rootMessage(Throwable error) {
        Throwable current = error;
        if (current instanceof InvocationTargetException && ((InvocationTargetException) current).getCause() != null) {
            current = ((InvocationTargetException) current).getCause();
        }
        while (current.getCause() != null && current.getCause() != current) current = current.getCause();
        String message = current.getMessage();
        return current.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }
}
