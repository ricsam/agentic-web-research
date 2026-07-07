import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Website from "./Website";
import "./index.css";

const Root = window.location.pathname.startsWith("/admin") ? App : Website;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

