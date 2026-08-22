import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const devHost = process.env.VITE_DEV_HOST ?? "0.0.0.0";
const devPort = Number(process.env.VITE_DEV_PORT ?? 5227);
const previewPort = Number(process.env.VITE_PREVIEW_PORT ?? 4173);

export default defineConfig({
  // The web app uses clean TanStack Router paths. Vite dev/preview must serve
  // index.html for those paths on a hard reload.
  appType: "spa",
  plugins: [tanstackRouter(), tailwindcss(), react()],
  server: {
    host: devHost,
    port: devPort,
    strictPort: true,
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  preview: {
    port: previewPort,
    host: "0.0.0.0",
    strictPort: true,
  },
});
