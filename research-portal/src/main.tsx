import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// Settings' shared styles stay in the main stylesheet: Sales & Support and the experiment
// builder use the same classes and may open before Settings has ever loaded.
import "./settingsChrome.css";
import "./commissioning.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
