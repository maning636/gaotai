// 截取所有功能页面截图，输出到 D:\dim开发\新版功能截图\
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const BASE = "http://127.0.0.1:3060";
const PASSWORD = process.env.APP_PASSWORD || "9971c6ae84b62caac8427d2f";
const OUT = path.resolve("D:\\dim开发\\新版功能截图");

const SAMPLE_ARTICLE = `# 从零到一：独立开发者的第一款产品

做独立开发最难的不是写代码，是决定做什么。

很多人一上来就想做个大平台，结果做了三个月发现没人用。问题不在技术，在于没有先找到十个愿意付费的人。

## 第一步：找到一个痛点

痛点不是"我觉得这个不好用"，而是"别人也在抱怨这件事"。去论坛、社群、评论区里看，同一个问题被反复提起，那就是痛点。

## 第二步：做最小版本

最小版本不是半成品，是只解决那个痛点的版本。砍掉所有"以后可能要"的功能，只留"现在就要"的。

## 第三步：找到第一批用户

不要等产品完美再发布。第一天就让人用，反馈比想象中多。

\`\`\`javascript
function validateIdea(problem) {
  const users = findComplainers(problem);
  return users.length >= 10;
}
\`\`\`

$$E=mc^2$$

| 阶段 | 目标 | 时间 |
|---|---|---|
| 验证 | 找到10个愿意付费的人 | 2周 |
| MVP | 只做核心功能 | 4周 |
| 发布 | 让第一批用户用上 | 1周 |
`;

const SHOTS = [
  { name: "01-登录页", path: "/login", setup: null },
  { name: "02-工作台首页", path: "/", setup: null },
  { name: "03-稿件列表", path: "/projects", setup: null },
  { name: "04-模板库", path: "/templates", setup: null },
  { name: "05-公众号配置", path: "/wechat", setup: null },
  { name: "06-模型配置", path: "/agent-config", setup: null },
  { name: "07-安全授权", path: "/security", setup: null },
  { name: "08-多平台分发", path: "/publish/multi-platform", setup: null },
];

// 需要稿件的页面
const PROJECT_SHOTS = [
  { name: "09-编辑器", pathFn: id => `/projects/${id}` },
  { name: "10-排版预览页", pathFn: id => `/projects/${id}/preview` },
  { name: "11-知识卡片模式", pathFn: id => `/projects/${id}/cards` },
];

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { offscreen: false, nodeIntegration: false, sandbox: false },
  });
  // 禁用 GPU 避免缓存权限冲突
  win.webContents.session.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36");
  win.setContentSize(1439, 899);
  await new Promise(r => setTimeout(r, 300));

  const results = [];

  try {
    // 登录
    await win.loadURL(`${BASE}/login`);
    await new Promise(r => setTimeout(r, 800));
    const loginRes = await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/auth/login", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:"${PASSWORD}"})}).then(r=>r.json().then(b=>({ok:r.ok,text:b.error||""}))).catch(()=>({ok:false,text:""}))`
    );
    if (!loginRes.ok) throw new Error(`登录失败: ${loginRes.text}`);
    console.log("[shot] 登录成功");
    await new Promise(r => setTimeout(r, 300));

    // 创建测试稿件 + 写正文
    const createRes = await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"截图测试稿件",topicId:"demo"})}).then(r=>r.json()).catch(e=>({error:String(e)}))`
    );
    const projectId = createRes.project?.id || createRes.id;
    if (!projectId) throw new Error(`创建稿件失败: ${JSON.stringify(createRes)}`);
    console.log("[shot] 稿件:", projectId);

    await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/projects/${projectId}/stages/article",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:${JSON.stringify(SAMPLE_ARTICLE)}})})`
    );
    await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/projects/${projectId}/stages/article/confirm",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:${JSON.stringify(SAMPLE_ARTICLE)}})})`
    );
    console.log("[shot] 正文已写入并确认");

    // 截固定路径页面
    for (const shot of SHOTS) {
      await win.loadURL(`${BASE}${shot.path}`);
      await new Promise(r => setTimeout(r, 1800));
      const image = await win.webContents.capturePage();
      const size = image.getSize();
      const file = path.join(OUT, `${shot.name}-${size.width}x${size.height}.png`);
      await fs.promises.writeFile(file, image.toPNG());
      console.log(`[shot] ${shot.name} ✓`, file);
      results.push(file);
    }

    // 截需要稿件的页面
    for (const shot of PROJECT_SHOTS) {
      const url = `${BASE}${shot.pathFn(projectId)}`;
      await win.loadURL(url);
      await new Promise(r => setTimeout(r, 2000));
      const image = await win.webContents.capturePage();
      const size = image.getSize();
      const file = path.join(OUT, `${shot.name}-${size.width}x${size.height}.png`);
      await fs.promises.writeFile(file, image.toPNG());
      console.log(`[shot] ${shot.name} ✓`, file);
      results.push(file);
    }

    // 清理测试稿件
    await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/projects/${projectId}",{method:"DELETE"})`
    );
    console.log("[shot] 测试稿件已清理");

    console.log(`\n__SHOTS_RESULT__ ${JSON.stringify({ ok: true, count: results.length, files: results })}`);
  } catch (error) {
    console.error("[shot] 错误:", error);
    console.log(`__SHOTS_RESULT__ ${JSON.stringify({ ok: false, error: String(error) })}`);
  } finally {
    win.destroy();
    app.quit();
  }
});
