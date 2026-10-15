"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachBrowserViewer = attachBrowserViewer;
const net = __importStar(require("net"));
const crypto_1 = require("crypto");
const browserViewerProtocol_1 = require("./browserViewerProtocol");
const attached = new WeakSet();
/** Runs inside the existing MCP process. Only observation CDP methods are used. */
function attachBrowserViewer(page, connection) {
    if (attached.has(page))
        return;
    attached.add(page);
    let socket, cdp;
    let closed = false, active = false, awaitingAck = false, lastFrameAt = 0, attempt = 0, generation = 0;
    let retry, metadataTimer;
    let frameTimer;
    let titleTimer;
    let titlePending = false, lastTitle = "Страница";
    let latest;
    let transition = Promise.resolve();
    const pageId = (0, crypto_1.randomUUID)();
    const send = (message) => {
        if (socket && !socket.destroyed && socket.writableLength < browserViewerProtocol_1.VIEWER_MAX_FRAME)
            socket.write(`${JSON.stringify(message)}\n`);
    };
    const metadata = async () => {
        // A modal dialog can suspend page.title(); do not accumulate evaluations.
        if (!titlePending) {
            titlePending = true;
            const lookup = Promise.resolve().then(() => page.title()).then(title => {
                lastTitle = title.slice(0, 256);
                titlePending = false;
            }, () => { titlePending = false; });
            await Promise.race([lookup, new Promise(resolve => { titleTimer = setTimeout(resolve, 1000); titleTimer.unref(); })]);
            clearTimeout(titleTimer);
        }
        if (!closed)
            send({ type: "page", title: lastTitle, url: page.url().slice(0, 4096) });
    };
    const flush = () => {
        clearTimeout(frameTimer);
        frameTimer = undefined;
        if (!active || closed || awaitingAck || !latest || !socket || socket.destroyed)
            return;
        const delay = Math.max(0, 200 - (Date.now() - lastFrameAt));
        if (delay || socket.writableLength) {
            frameTimer = setTimeout(flush, Math.max(delay, 50));
            frameTimer.unref();
            return;
        }
        const frame = latest;
        latest = undefined;
        awaitingAck = true;
        lastFrameAt = Date.now();
        send({ type: "frame", ...frame });
    };
    const setStreaming = (next) => {
        active = next;
        awaitingAck = false;
        latest = undefined;
        lastFrameAt = 0;
        clearTimeout(frameTimer);
        const current = ++generation;
        transition = transition.then(async () => {
            if (closed || current !== generation)
                return;
            try {
                if (next && !cdp) {
                    const session = await page.context().newCDPSession(page);
                    if (closed) {
                        await session.detach().catch(() => { });
                        return;
                    }
                    cdp = session;
                    cdp.on("Page.screencastFrame", (frame) => {
                        void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => { });
                        if (!active || closed || frame.data.length > browserViewerProtocol_1.VIEWER_MAX_FRAME)
                            return;
                        latest = { data: frame.data, width: Math.round(frame.metadata.deviceWidth), height: Math.round(frame.metadata.deviceHeight) };
                        flush();
                    });
                }
                if (closed || current !== generation)
                    return;
                if (next)
                    await cdp?.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
                else
                    await cdp?.send("Page.stopScreencast");
            }
            catch {
                if (!closed)
                    send({ type: "error" });
            }
        }).catch(() => { });
    };
    const cleanup = () => {
        if (closed)
            return;
        closed = true;
        active = false;
        generation++;
        clearTimeout(retry);
        clearInterval(metadataTimer);
        clearTimeout(frameTimer);
        clearTimeout(titleTimer);
        latest = undefined;
        page.off("close", cleanup);
        socket?.destroy();
        void cdp?.detach().catch(() => { });
    };
    const connect = () => {
        if (closed || page.isClosed()) {
            cleanup();
            return;
        }
        const client = net.createConnection(connection.socketPath);
        socket = client;
        client.unref();
        let input = "", connected = false;
        client.setEncoding("utf8");
        client.on("connect", () => {
            connected = true;
            send({ type: "hello", token: connection.token, pageId, title: "Страница", url: page.url().slice(0, 4096) });
            void metadata();
            metadataTimer = setInterval(() => { void metadata(); }, 1500);
            metadataTimer.unref();
        });
        client.on("error", () => { });
        client.on("close", () => {
            if (closed)
                return;
            if (!connected && ++attempt < 20) {
                retry = setTimeout(connect, 250);
                retry.unref();
            }
            else
                cleanup();
        });
        client.on("data", chunk => {
            input += chunk;
            if (Buffer.byteLength(input, "utf8") > 8192) {
                cleanup();
                return;
            }
            let end;
            while ((end = input.indexOf("\n")) !== -1) {
                const line = input.slice(0, end);
                input = input.slice(end + 1);
                try {
                    const value = JSON.parse(line);
                    if (value.type === "stream" && typeof value.active === "boolean")
                        setStreaming(value.active);
                    else if (value.type === "ack") {
                        awaitingAck = false;
                        flush();
                    }
                }
                catch {
                    cleanup();
                    return;
                }
            }
        });
    };
    page.on("close", cleanup);
    connect();
}
//# sourceMappingURL=browserViewerHook.js.map