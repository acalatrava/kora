import { BrowserWindow, BrowserView, ApplicationMenu, type RPCSchema, Utils } from "electrobun/bun";

type KoraRPC = {
  bun: RPCSchema<{
    requests: {
      httpFetch: {
        params: {
          url: string;
          method: string;
          headers: Record<string, string>;
          body: string | null;
        };
        response: {
          ok: boolean;
          status: number;
          statusText: string;
          bodyText: string;
          contentType: string;
        };
      };
      openExternal: { params: { url: string }; response: { ok: boolean } };
      wsOpen: { params: { url: string }; response: { ok: boolean; error?: string } };
      wsSend: { params: { text: string }; response: { ok: boolean } };
      wsClose: { params: Record<string, never>; response: { ok: boolean } };
    };
    messages: Record<string, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      wsEvent: { type: string; data?: string; error?: string };
    };
  }>;
};

let mainWindow: BrowserWindow;
let activeWs: WebSocket | null = null;

const koraRpc = BrowserView.defineRPC<KoraRPC>({
  maxRequestTime: Infinity,
  handlers: {
    requests: {
      httpFetch: async ({ url, method, headers, body }) => {
        const res = await fetch(url, {
          method,
          headers,
          ...(body ? { body } : {}),
        });
        const bodyText = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          bodyText,
          contentType: res.headers.get("content-type") || "",
        };
      },
      openExternal: ({ url }) => {
        Utils.openExternal(url);
        return { ok: true };
      },
      wsOpen: ({ url }) => {
        try {
          console.log("wsOpen", url);
          activeWs?.close();
          const ws = new WebSocket(url);
          activeWs = ws;
          ws.addEventListener("open", () => {
            console.log("wsOpen");
            mainWindow.webview.rpc!.send.wsEvent({ type: "open" });
          });
          ws.addEventListener("message", (ev) => {
            console.log("wsMessage", ev);
            let text: string;
            const d = ev.data;
            if (typeof d === "string") {
              text = d;
            } else if (d instanceof ArrayBuffer) {
              text = new TextDecoder().decode(d);
            } else if (Buffer.isBuffer(d)) {
              text = d.toString("utf-8");
            } else {
              text = String(d);
            }
            mainWindow.webview.rpc!.send.wsEvent({ type: "message", data: text });
          });
          ws.addEventListener("error", (e) => {
            console.log("wsError", e);
            mainWindow.webview.rpc!.send.wsEvent({ type: "error" });
          });
          ws.addEventListener("close", () => {
            console.log("wsClose");
            if (activeWs === ws) activeWs = null;
            mainWindow.webview.rpc!.send.wsEvent({ type: "close" });
          });
          return { ok: true };
        } catch (e) {
          console.log("wsOpen error", e);
          return { ok: false, error: (e as Error).message };
        }
      },
      wsSend: ({ text }) => {
        if (activeWs?.readyState === WebSocket.OPEN) {
          activeWs.send(text);
          return { ok: true };
        }
        return { ok: false };
      },
      wsClose: () => {
        activeWs?.close();
        activeWs = null;
        return { ok: true };
      },
    },
    messages: {},
  },
});

ApplicationMenu.setApplicationMenu([
  {
    label: "Kora",
    submenu: [
      { role: "hide" },
      { role: "hideOthers" },
      { role: "showAll" },
      { type: "separator" },
      { role: "quit" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
]);

mainWindow = new BrowserWindow({
  title: "Kora",
  url: "views://mainview/index.html",
  rpc: koraRpc,
  frame: {
    width: 1100,
    height: 750,
    x: 0,
    y: 0,
  },
});
