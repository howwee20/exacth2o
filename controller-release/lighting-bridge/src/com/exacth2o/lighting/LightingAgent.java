package com.exacth2o.lighting;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
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

/**
 * Additive ExactH2O bridge for the legacy chamber controller.
 *
 * This agent never opens the FPGA or creates a second controller. It joins the
 * already-running JVM and calls the same static Control API used by the local
 * Swing maintenance screen and experiment timeline.
 */
public final class LightingAgent {
    private static final String VERSION = "exacth2o-lighting-bridge-1.0.0";
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);

    private LightingAgent() {
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
        Thread bridge = new Thread(new Bridge(new File(arguments.trim())), "ExactH2O-Lighting-Bridge");
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

        Bridge(File configurationFile) {
            this.configurationFile = configurationFile;
        }

        public void run() {
            try {
                bindController();
                log("Bridge attached to the existing PhenoSystemControl Control API.");
                while (true) {
                    Properties configuration = loadConfiguration();
                    if (!Boolean.parseBoolean(configuration.getProperty("enabled", "true"))) {
                        log("Bridge disabled by configuration.");
                        return;
                    }

                    long pollMs = parseLong(configuration.getProperty("poll_ms"), 1000L, 500L, 10000L);
                    try {
                        double controllerIntensity = readControllerIntensity();
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
                log("Bridge stopped.");
            } catch (Throwable fatal) {
                log("Bridge stopped: " + rootMessage(fatal));
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
                if (!success) errorMessage = "Control.getIntensity did not retain the requested value";
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
                    ? "Portal intensity " + jsonNumber(command.intensity) + " applied through Control.update()."
                    : "Portal command failed: " + errorMessage);
            } catch (Throwable resultError) {
                log("Unable to send command receipt: " + rootMessage(resultError));
            }
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
                    new File(configurationFile.getParentFile(), "lighting-agent.log").getAbsolutePath()
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
