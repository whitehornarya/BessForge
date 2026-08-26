import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);

// Dev-only scripted smoke pass for aisle drags: /?smoke=aisle
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("smoke") === "aisle") {
  import("./lib/smokeAisle").then(m => m.runAisleSmoke());
}
