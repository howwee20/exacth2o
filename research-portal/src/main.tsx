import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

async function mount() {
  const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("rd-preview") === "1";
  const Component = preview ? (await import("./rdPreview")).default : App;
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Component />
    </React.StrictMode>,
  );
}

void mount();
