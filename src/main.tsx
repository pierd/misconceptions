import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { PostHogProvider } from 'posthog-js/react'

const options = {
  api_host: 'https://wieprz.lessismore.studio/eu',
  ui_host: 'https://eu.posthog.com',
  defaults: '2025-11-30',
} as const

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PostHogProvider apiKey="phc_x3SANkZqFs3dgNONhp90L2BuNYPtfhEarq6pIcZ3An2" options={options}>
      <App />
    </PostHogProvider>
  </StrictMode>
);
