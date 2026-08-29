import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const devHost = process.env.VITE_DEV_HOST ?? "127.0.0.1";
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
    allowedHosts: true,
  },
  preview: {
    port: previewPort,
    host: devHost,
    strictPort: true,
    allowedHosts: true,
  },
});
