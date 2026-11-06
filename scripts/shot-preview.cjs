// 截图排版预览页：登录→造稿件→写正文→截 /projects/[id]/preview
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const BASE = process.env.SHOT_BASE || "http://127.0.0.1:3060";
const PASSWORD = process.env.APP_PASSWORD || "dev";
const OUT = path.resolve(__dirname, "..", "shots");

const SAMPLE_ARTICLE = `# 从零到一：独立开发者的第一款产品

做独立开发最难的不是写代码，是决定做什么。

很多人一上来就想做个大平台，结果做了三个月发现没人用。问题不在技术，在于没有先找到十个愿意付费的人。

## 第一步：找到一个痛点

痛点不是"我觉得这个不好用"，而是"别人也在抱怨这件事"。去论坛、社群、评论区里看，同一个问题被反复提起，那就是痛点。

## 第二步：做最小版本

最小版本不是半成品，是只解决那个痛点的版本。砍掉所有"以后可能要"的功能，只留"现在就要"的。

## 第三步：找到第一批用户

不要等产品完美再发布。第一天就让人用，反馈比想象中多。`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { offscreen: false, nodeIntegration: false },
  });
  win.setContentSize(1439, 899);
  await new Promise(r => setTimeout(r, 200));

  try {
    // 登录
    await win.loadURL(`${BASE}/login`);
    await new Promise(r => setTimeout(r, 500));
    const loginRes = await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${BASE}/api/auth/login`)}, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:${JSON.stringify(PASSWORD)}})}).then(r=>r.json().then(b=>({ok:r.ok,status:r.status,text:b.error||""}))).catch(()=>({ok:false,status:0,text:""}))`
    );
    if (!loginRes.ok) throw new Error(`登录失败: ${loginRes.text}`);
    console.log("[shot] 登录成功");
    await new Promise(r => setTimeout(r, 300));

    // 创建稿件
    const createRes = await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${BASE}/api/projects`)},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"截图测试稿件",topicId:"demo"})}).then(r=>r.json()).catch(e=>({error:String(e)}))`
    );
    const projectId = createRes.project?.id || createRes.id;
    if (!projectId) throw new Error(`创建稿件失败: ${JSON.stringify(createRes)}`);
    console.log("[shot] 稿件创建:", projectId);

    // 写正文到 article 阶段
    await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${BASE}/api/projects/${projectId}/stages/article`)},{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:${JSON.stringify(SAMPLE_ARTICLE)}})})`
    );
    console.log("[shot] 正文已写入");

    // 确认正文阶段
    await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${BASE}/api/projects/${projectId}/stages/article/confirm`)},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:${JSON.stringify(SAMPLE_ARTICLE)}})})`
    );
    console.log("[shot] 正文已确认");

    // 加载排版预览页
    await win.loadURL(`${BASE}/projects/${projectId}/preview`);
    await new Promise(r => setTimeout(r, 2000));

    // 截图
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    const file = path.join(OUT, `10-排版预览页-${size.width}x${size.height}@2x.png`);
    await fs.promises.writeFile(file, image.toPNG());
    console.log("[shot] 排版预览页 ✓", file);

    // 也截一张编辑器底部（看「去排版预览」按钮）
    await win.loadURL(`${BASE}/projects/${projectId}`);
    await new Promise(r => setTimeout(r, 1500));
    const image2 = await win.webContents.capturePage();
    const size2 = image2.getSize();
    const file2 = path.join(OUT, `11-编辑器底部-${size2.width}x${size2.height}@2x.png`);
    await fs.promises.writeFile(file2, image2.toPNG());
    console.log("[shot] 编辑器底部 ✓", file2);

    // 清理测试稿件
    await win.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${BASE}/api/projects/${projectId}`)},{method:"DELETE"})`
    );
    console.log("[shot] 测试稿件已清理");

    console.log(`__SHOTS_RESULT__ ${JSON.stringify({ ok: true, results: [
      { label: "排版预览页", file },
      { label: "编辑器底部", file: file2 },
    ] })}`);
  } catch (error) {
    console.error("[shot] 错误:", error);
    console.log(`__SHOTS_RESULT__ ${JSON.stringify({ ok: false, error: String(error) })}`);
  } finally {
    win.destroy();
    app.quit();
  }
});
