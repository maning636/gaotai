// 截图：排版预览页（手机铺满）+ 知识卡片多状态
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

不要等产品完美再发布。第一天就让人用，反馈比想象中多。`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { offscreen: false, nodeIntegration: false, sandbox: false },
  });
  win.setContentSize(1439, 899);
  await new Promise(r => setTimeout(r, 300));

  try {
    // 登录
    await win.loadURL(`${BASE}/login`);
    await new Promise(r => setTimeout(r, 800));
    const loginRes = await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/auth/login", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:"${PASSWORD}"})}).then(r=>r.json().then(b=>({ok:r.ok,text:b.error||""}))).catch(()=>({ok:false,text:""}))`
    );
    if (!loginRes.ok) throw new Error(`登录失败: ${loginRes.text}`);
    console.log("[shot] 登录成功");

    // 创建稿件+写正文+确认
    const createRes = await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"截图测试稿件",topicId:"demo"})}).then(r=>r.json())`
    );
    const projectId = createRes.project?.id || createRes.id;
    if (!projectId) throw new Error(`创建稿件失败: ${JSON.stringify(createRes)}`);
    console.log("[shot] 稿件:", projectId);

    await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/projects/${projectId}/stages/article",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(${JSON.stringify(JSON.stringify({content: SAMPLE_ARTICLE}))})})`
    );
    await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/projects/${projectId}/stages/article/confirm",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(${JSON.stringify(JSON.stringify({content: SAMPLE_ARTICLE}))})})`
    );
    console.log("[shot] 正文已写入");

    // 1. 排版预览页（手机铺满后）
    await win.loadURL(`${BASE}/projects/${projectId}/preview`);
    await new Promise(r => setTimeout(r, 2500));
    let img = await win.webContents.capturePage();
    let sz = img.getSize();
    let file = path.join(OUT, `10-排版预览页-手机铺满-${sz.width}x${sz.height}.png`);
    await fs.promises.writeFile(file, img.toPNG());
    console.log("[shot] 排版预览页(手机铺满) ✓");

    // 2. 知识卡片 — 默认状态
    await win.loadURL(`${BASE}/projects/${projectId}/cards`);
    await new Promise(r => setTimeout(r, 2500));
    img = await win.webContents.capturePage();
    sz = img.getSize();
    file = path.join(OUT, `11-知识卡片-默认状态-${sz.width}x${sz.height}.png`);
    await fs.promises.writeFile(file, img.toPNG());
    console.log("[shot] 知识卡片(默认) ✓");

    // 3. 知识卡片 — 点击不同主题（简单白）
    // 通过 JS 点击第一个主题方块
    await win.webContents.executeJavaScript(
      `(() => { const items = document.querySelectorAll('[class*="themeItem"], [class*="cardTheme"]'); if (items.length > 1) { items[1].click(); return 'clicked theme 1'; } return 'no items found: ' + document.querySelectorAll('button').length + ' buttons'; })()`
    ).then(r => console.log("[shot] 主题点击:", r));
    await new Promise(r => setTimeout(r, 1500));
    img = await win.webContents.capturePage();
    sz = img.getSize();
    file = path.join(OUT, `12-知识卡片-主题2-${sz.width}x${sz.height}.png`);
    await fs.promises.writeFile(file, img.toPNG());
    console.log("[shot] 知识卡片(主题2) ✓");

    // 4. 知识卡片 — 换第三个主题
    await win.webContents.executeJavaScript(
      `(() => { const items = document.querySelectorAll('[class*="themeItem"], [class*="cardTheme"]'); if (items.length > 2) { items[2].click(); return 'clicked theme 2'; } return 'no'; })()`
    ).then(r => console.log("[shot] 主题点击:", r));
    await new Promise(r => setTimeout(r, 1500));
    img = await win.webContents.capturePage();
    sz = img.getSize();
    file = path.join(OUT, `13-知识卡片-主题3-${sz.width}x${sz.height}.png`);
    await fs.promises.writeFile(file, img.toPNG());
    console.log("[shot] 知识卡片(主题3) ✓");

    // 5. 知识卡片 — 换比例（点 3:5 按钮）
    await win.webContents.executeJavaScript(
      `(() => { const btns = document.querySelectorAll('button'); for (const b of btns) { if (b.textContent.includes('3:5')) { b.click(); return 'clicked 3:5'; } } return 'no 3:5 button'; })()`
    ).then(r => console.log("[shot] 比例点击:", r));
    await new Promise(r => setTimeout(r, 1500));
    img = await win.webContents.capturePage();
    sz = img.getSize();
    file = path.join(OUT, `14-知识卡片-比例3比5-${sz.width}x${sz.height}.png`);
    await fs.promises.writeFile(file, img.toPNG());
    console.log("[shot] 知识卡片(3:5) ✓");

    // 6. 知识卡片 — 换比例 9:16
    await win.webContents.executeJavaScript(
      `(() => { const btns = document.querySelectorAll('button'); for (const b of btns) { if (b.textContent.includes('9:16')) { b.click(); return 'clicked 9:16'; } } return 'no 9:16 button'; })()`
    ).then(r => console.log("[shot] 比例点击:", r));
    await new Promise(r => setTimeout(r, 1500));
    img = await win.webContents.capturePage();
    sz = img.getSize();
    file = path.join(OUT, `15-知识卡片-比例9比16-${sz.width}x${sz.height}.png`);
    await fs.promises.writeFile(file, img.toPNG());
    console.log("[shot] 知识卡片(9:16) ✓");

    // 清理
    await win.webContents.executeJavaScript(
      `fetch("${BASE}/api/projects/${projectId}",{method:"DELETE"})`
    );
    console.log("[shot] 测试稿件已清理");

    // 列出所有截图
    const files = fs.readdirSync(OUT).filter(f => f.endsWith(".png")).sort();
    console.log(`\n=== 截图清单 (${files.length} 张) ===`);
    for (const f of files) {
      const stat = fs.statSync(path.join(OUT, f));
      console.log(`  ${f}  (${Math.round(stat.size / 1024)}KB)`);
    }
    console.log(`__SHOTS_RESULT__ ${JSON.stringify({ ok: true, count: files.length })}`);
  } catch (error) {
    console.error("[shot] 错误:", error);
    console.log(`__SHOTS_RESULT__ ${JSON.stringify({ ok: false, error: String(error) })}`);
  } finally {
    win.destroy();
    app.quit();
  }
});
