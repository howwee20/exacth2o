import { createRoot } from "react-dom/client";
import App from "@portal-src/App";
// Same stylesheets as research-portal/src/main.tsx.
import "@portal-src/styles.css";
import "@portal-src/settingsChrome.css";
import "@portal-src/commissioning.css";

createRoot(document.getElementById("root")!).render(<App />);
