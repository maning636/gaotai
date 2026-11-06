import { assertEqual, assertMatch, assertTrue, suite } from "./harness";
import {
  BridgeCore,
  computeAcceptKey,
  encodeFrame,
  FrameDecoder,
  MAX_EXTENSION_SESSIONS,
  parseTextFrame,
  PLATFORMS,
} from "../lib/bridge/protocol";

suite("桥协议 · WebSocket 帧", ({ test }) => {
  test("computeAcceptKey 按 RFC 6455 计算", () => {
    // RFC 6455 第 1.3 节示例。
    assertEqual(
      computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });

  test("文本帧 round-trip（未掩码）", () => {
    const frame = encodeFrame(0x1, "hello 稿台");
    const decoder = new FrameDecoder();
    const frames = decoder.push(frame);
    assertEqual(frames.length, 1);
    assertEqual(frames[0].opcode, 0x1);
    assertEqual(frames[0].payload.toString("utf8"), "hello 稿台");
    assertEqual(frames[0].masked, false);
  });

  test("掩码帧 round-trip（客户端→服务端）", () => {
    const frame = encodeFrame(0x1, "你好，扩展", true);
    assertEqual(frame[1] & 0x80, 0x80, "掩码位必须置位");
    const decoder = new FrameDecoder();
    const frames = decoder.push(frame);
    assertEqual(frames.length, 1);
    assertEqual(frames[0].payload.toString("utf8"), "你好，扩展");
    assertEqual(frames[0].masked, true);
  });

  test("长帧（126 长度编码）round-trip", () => {
    const text = "长".repeat(200);
    const frame = encodeFrame(0x1, text, true);
    assertEqual(frame[1] & 0x7f, 126, "应使用 16 位扩展长度");
    const decoder = new FrameDecoder();
    const frames = decoder.push(frame);
    assertEqual(frames.length, 1);
    assertEqual(frames[0].payload.toString("utf8"), text);
  });

  test("帧跨 chunk 到达时能正确重组", () => {
    const frame = encodeFrame(0x1, "分片消息测试", true);
    const decoder = new FrameDecoder();
    const half = Math.floor(frame.length / 2);
    const first = decoder.push(frame.subarray(0, half));
    assertEqual(first.length, 0, "前半段不完整，不应解出帧");
    const second = decoder.push(frame.subarray(half));
    assertEqual(second.length, 1);
    assertEqual(second[0].payload.toString("utf8"), "分片消息测试");
  });

  test("一个 chunk 里挤着多条帧能全部解出", () => {
    const a = encodeFrame(0x1, "第一条", false);
    const b = encodeFrame(0x1, "第二条", true);
    const decoder = new FrameDecoder();
    const frames = decoder.push(Buffer.concat([a, b]));
    assertEqual(frames.length, 2);
    assertEqual(frames[0].payload.toString("utf8"), "第一条");
    assertEqual(frames[1].payload.toString("utf8"), "第二条");
  });

  test("parseTextFrame 解析合法 JSON，非法返回 null", () => {
    assertEqual(parseTextFrame(Buffer.from('{"a":1}')), { a: 1 });
    assertEqual(parseTextFrame(Buffer.from("not json")), null);
  });
});

suite("桥协议 · JSON-RPC 派发", ({ test }) => {
  test("listPlatforms 返回正确平台列表", () => {
    const core = new BridgeCore();
    const session = core.addSession({ role: "backend", clientId: "test" });
    assertTrue(session !== null);
    const response = core.handleMessage(session!.sessionId, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "listPlatforms", params: {} }));
    const parsed = JSON.parse(response!) as { result?: { platforms?: string[] } };
    assertEqual(parsed.result?.platforms, [...PLATFORMS]);
  });

  test("hello 握手返回 paired 与 sessionId", () => {
    const core = new BridgeCore();
    const session = core.addSession({ role: "extension", clientId: "ext-1" });
    assertTrue(session !== null);
    const response = core.handleMessage(session!.sessionId, JSON.stringify({ jsonrpc: "2.0", id: "h1", method: "hello", params: { clientId: "ext-1" } }));
    const parsed = JSON.parse(response!) as { result?: { paired?: boolean; sessionId?: string; clientId?: string } };
    assertEqual(parsed.result?.paired, true);
    assertEqual(parsed.result?.sessionId, session!.sessionId);
    assertEqual(parsed.result?.clientId, "ext-1");
  });

  test("未知方法返回 JSON-RPC error", () => {
    const core = new BridgeCore();
    const session = core.addSession({ role: "backend", clientId: "test" });
    const response = core.handleMessage(session!.sessionId, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "noSuchMethod", params: {} }));
    const parsed = JSON.parse(response!) as { error?: { code?: number } };
    assertEqual(parsed.error?.code, -32601);
  });

  test("malformed JSON 返回解析错误", () => {
    const core = new BridgeCore();
    const session = core.addSession({ role: "backend", clientId: "test" });
    const response = core.handleMessage(session!.sessionId, "{ this is not json");
    const parsed = JSON.parse(response!) as { error?: { code?: number } };
    assertEqual(parsed.error?.code, -32700);
  });

  test("syncArticle 无扩展时任务置为 failed", () => {
    const core = new BridgeCore();
    const session = core.addSession({ role: "backend", clientId: "test" });
    const response = core.handleMessage(session!.sessionId, JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "syncArticle",
      params: { platform: "zhihu", title: "t", content: "c", html: "<p>c</p>" },
    }));
    const parsed = JSON.parse(response!) as { result?: { ok?: boolean; taskId?: string } };
    assertEqual(parsed.result?.ok, true);
    const task = core.getTask(parsed.result!.taskId!);
    assertEqual(task?.status, "failed");
  });

  test("syncArticle 推送给已连接扩展会话", () => {
    const core = new BridgeCore();
    const ext = core.addSession({ role: "extension", clientId: "ext-1" });
    const be = core.addSession({ role: "backend", clientId: "backend" });
    assertTrue(ext !== null && be !== null);

    const response = core.handleMessage(be!.sessionId, JSON.stringify({
      jsonrpc: "2.0", id: 4, method: "syncArticle",
      params: { platform: "juejin", title: "标题", content: "# 正文", html: "<h1>正文</h1>" },
    }));
    const parsed = JSON.parse(response!) as { result?: { taskId?: string } };
    const taskId = parsed.result!.taskId!;
    const task = core.getTask(taskId);
    assertEqual(task?.status, "delivered");

    // 扩展会话应收到 syncArticle 请求，sessionId 必须指向真实扩展会话。
    const outbox = core.drainOutbox();
    const toExt = outbox.find(o => o.sessionId === ext!.sessionId);
    assertTrue(toExt !== undefined, "扩展会话应收到推送");
    assertTrue(typeof toExt!.sessionId === "string" && toExt!.sessionId.length > 0, "推送目标 sessionId 不能为空");
    const pushed = JSON.parse(toExt!.payload) as { method?: string; params?: { platform?: string; taskId?: string } };
    assertEqual(pushed.method, "syncArticle");
    assertEqual(pushed.params?.platform, "juejin");
    assertEqual(pushed.params?.taskId, taskId);
  });

  test("syncResult 后 getSyncTask 返回 done", () => {
    const core = new BridgeCore();
    const ext = core.addSession({ role: "extension", clientId: "ext-1" });
    const be = core.addSession({ role: "backend", clientId: "backend" });
    const sync = core.handleMessage(be!.sessionId, JSON.stringify({
      jsonrpc: "2.0", id: 5, method: "syncArticle",
      params: { platform: "csdn", title: "t", content: "c" },
    }));
    const taskId = (JSON.parse(sync!) as { result: { taskId: string } }).result.taskId;

    // 扩展回执。
    core.handleMessage(ext!.sessionId, JSON.stringify({
      jsonrpc: "2.0", id: 6, method: "syncResult", params: { taskId, ok: true, url: "https://example.com/a" },
    }));
    const task = core.getTask(taskId);
    assertEqual(task?.status, "done");
    assertEqual(task?.result?.url, "https://example.com/a");

    const query = core.handleMessage(be!.sessionId, JSON.stringify({
      jsonrpc: "2.0", id: 7, method: "getSyncTask", params: { taskId },
    }));
    const q = JSON.parse(query!) as { result?: { status?: string; result?: { url?: string } } };
    assertEqual(q.result?.status, "done");
    assertEqual(q.result?.result?.url, "https://example.com/a");
  });

  test("会话上限 4 个扩展，超限被拒", () => {
    const core = new BridgeCore();
    for (let i = 0; i < MAX_EXTENSION_SESSIONS; i++) {
      const s = core.addSession({ role: "extension", clientId: `ext-${i}` });
      assertTrue(s !== null, `第 ${i + 1} 个扩展应能加入`);
    }
    const over = core.addSession({ role: "extension", clientId: "ext-over" });
    assertEqual(over, null, "第 5 个扩展应被拒绝");
    // 后端会话不占扩展额度。
    const backend = core.addSession({ role: "backend", clientId: "backend" });
    assertTrue(backend !== null, "后端会话应能加入");
  });

  test("broadcastState 返回 state 通知", () => {
    const core = new BridgeCore();
    const state = core.broadcastState("sess-1", { clients: 2 });
    const parsed = JSON.parse(state) as { method?: string; params?: { clients?: number } };
    assertEqual(parsed.method, "state");
    assertEqual(parsed.params?.clients, 2);
  });

  test("不存在的会话返回错误", () => {
    const core = new BridgeCore();
    const response = core.handleMessage("no-such-session", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: {} }));
    const parsed = JSON.parse(response!) as { error?: { code?: number } };
    assertEqual(parsed.error?.code, -32000);
  });

  test("不支持的平台返回参数错误", () => {
    const core = new BridgeCore();
    const session = core.addSession({ role: "backend", clientId: "test" });
    const response = core.handleMessage(session!.sessionId, JSON.stringify({
      jsonrpc: "2.0", id: 8, method: "syncArticle",
      params: { platform: "weibo", title: "t", content: "c" },
    }));
    const parsed = JSON.parse(response!) as { error?: { code?: number } };
    assertEqual(parsed.error?.code, -32602);
    assertMatch(response!, /weibo/);
  });
});
