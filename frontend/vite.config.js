import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "logo-mark.png", "logo-full.png", "pwa-192.png", "pwa-512.png"],
      manifest: {
        name: "Maslah Academy AI",
        short_name: "Maslah AI",
        description: "AI-powered KCSE English setbook study assistant",
        theme_color: "#060f24",
        background_color: "#060f24",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      },
    }),
  ],
});
