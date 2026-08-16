import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createReviewApi } from "./api/client.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Reviewer root element is missing");
}

const api = await createReviewApi();
if (window.location.search || window.location.hash) {
  window.history.replaceState(null, "", window.location.pathname);
}

createRoot(root).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
