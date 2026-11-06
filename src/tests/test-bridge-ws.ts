import { strict as assert } from "node:assert";
import { createServer, connect, type Socket } from "node:net";
import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import {
  BridgeServer,
  DEFAULT_WS_PORT,
  MAX_PORT_TRIES,
  startWsServer,
  stopWsServer,
} from "../lib/bridge/ws-server";
import { computeAcceptKey, encodeFrame, FrameDecoder } from "../lib/bridge/protocol";
import { randomBytes } from "node:crypto";

/** 起一个占用端口的最小 TCP 服务（模拟端口冲突）。 */
function occupyPort(port: number): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      const addr = srv.address();
      resolve({ server: srv, port: addr && typeof addr === "object" ? addr.port : port });
    });
  });
}

/** 发起一个原始 WebSocket 客户端握手，返回 socket + 响应头。 */
function rawWsHandshake(
  port: number,
  path = "/extension",
  key = randomBytes(16).toString("base64"),
): Promise<{ socket: Socket; headers: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buffer = "";
    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`,
      );
    });
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\r\n\r\n");
      if (end !== -1) {
        resolve({ socket, headers: buffer.slice(0, end) });
      }
    });
    socket.on("error", reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("握手超时"));
    });
  });
}

suite("桥 WS · 端口与握手", ({ test }) => {
  test("握手成功并返回 101 + 正确 Sec-WebSocket-Accept", async () => {
    const server = new BridgeServer();
    const port = await server.start(DEFAULT_WS_PORT + 100); // 用偏移端口避免撞默认
    try {
      const key = randomBytes(16).toString("base64");
      const { socket, headers } = await rawWsHandshake(port, "/extension", key);
      assertMatch(headers, /HTTP\/1\.1 101/);
      // base64 含 + / = 等正则特殊字符，用 includes 比较更稳。
      assertTrue(
        headers.includes(`Sec-WebSocket-Accept: ${computeAcceptKey(key)}`),
        "Sec-WebSocket-Accept 应匹配 RFC 6455 计算值",
      );
      assertEqual(server.getClientCount(), 1);
      assertEqual(server.getExtensionCount(), 1);
      socket.destroy();
    } finally {
      server.close();
    }
  });

  test("端口被占用时自动 +1 直到空闲端口", async () => {
    const port = DEFAULT_WS_PORT + 200;
    const { server: occ, port: occPort } = await occupyPort(port);
    try {
      const bridge = new BridgeServer();
      const bound = await bridge.start(port);
      assertTrue(bound > occPort, "应换到下一个空闲端口");
      assertEqual(bound, occPort + 1);
      assertTrue(bridge.isRunning());
      bridge.close();
    } finally {
      occ.close();
    }
  });

  test("全部候选端口被占则启动失败", async () => {
    const base = DEFAULT_WS_PORT + 300;
    const occupied = [];
    try {
      for (let i = 0; i < MAX_PORT_TRIES; i++) {
        const { server, port } = await occupyPort(base + i);
        occupied.push({ server, port });
      }
      const bridge = new BridgeServer();
      await assert.rejects(
        bridge.start(base),
        /均被占用/,
        "所有端口被占时应抛错",
      );
    } finally {
      for (const o of occupied) o.server.close();
    }
  });
});

suite("桥 WS · 会话与帧", ({ test }) => {
  test("扩展会话上限 4，超限连接被 503 拒绝", async () => {
    const server = new BridgeServer({ maxExtensionSessions: 4 });
    const port = await server.start(DEFAULT_WS_PORT + 400);
    try {
      const sockets = [];
      for (let i = 0; i < 4; i++) {
        const { socket } = await rawWsHandshake(port, "/extension");
        sockets.push(socket);
      }
      assertEqual(server.getExtensionCount(), 4);

      // 第 5 个应被拒（HTTP 503）。
      const over = await rawWsHandshake(port, "/extension");
      assertMatch(over.headers, /HTTP\/1\.1 503/);
      over.socket.destroy();

      for (const s of sockets) s.destroy();
    } finally {
      server.close();
    }
  });

  test("文本帧经真实 socket round-trip，服务端收到并响应", async () => {
    const server = new BridgeServer();
    const port = await server.start(DEFAULT_WS_PORT + 500);
    try {
      const { socket, headers } = await rawWsHandshake(port, "/backend");
      assertMatch(headers, /HTTP\/1\.1 101/);

      // 客户端发一个 hello 请求（掩码帧），等响应来验证双向通信。
      const response = new Promise<string>((resolve, reject) => {
        const decoder = new FrameDecoder();
        socket.on("data", chunk => {
          for (const frame of decoder.push(chunk)) {
            if (frame.opcode === 0x1) resolve(frame.payload.toString("utf8"));
          }
        });
        socket.on("error", reject);
        socket.write(
          encodeFrame(
            0x1,
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { clientId: "backend" } }),
            true,
          ),
        );
      });

      const res = await response;
      const parsed = JSON.parse(res) as { result?: { paired?: boolean; sessionId?: string } };
      assertEqual(parsed.result?.paired, true);
      assertTrue(typeof parsed.result?.sessionId === "string" && parsed.result.sessionId.length > 0);
      socket.destroy();
    } finally {
      server.close();
    }
  });

  test("ping 收到后服务端回 pong", async () => {
    const server = new BridgeServer();
    const port = await server.start(DEFAULT_WS_PORT + 600);
    try {
      const { socket } = await rawWsHandshake(port, "/extension");
      const gotPong = new Promise<number>(resolve => {
        const decoder = new FrameDecoder();
        socket.on("data", chunk => {
          for (const frame of decoder.push(chunk)) {
            if (frame.opcode === 0xa) resolve(1);
          }
        });
      });
      socket.write(encodeFrame(0x9, Buffer.from("ping"), true));
      await gotPong;
      socket.destroy();
    } finally {
      server.close();
    }
  });
});

suite("桥 WS · 模块级单例", ({ test }) => {
  test("startWsServer/stopWsServer 生命周期", async () => {
    const { port, close } = await startWsServer(DEFAULT_WS_PORT + 700);
    assertTrue(port > 0);
    assertEqual(Number(process.env.GAOTAI_WS_PORT), port, "环境变量应写入实际端口");
    close();
    assertEqual(process.env.GAOTAI_WS_PORT, undefined, "关闭后环境变量应清除");
    stopWsServer();
  });
});
