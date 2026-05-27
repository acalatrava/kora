import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Kora Client",
    identifier: "com.mobileinnova.korabot",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      "mainview": {
        entrypoint: "src/views/main/index.ts",
      },
    },
    copy: {
      "src/views/main/index.html": "views/mainview/index.html",
      "src/views/main/style.css": "views/mainview/style.css",
    },
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;