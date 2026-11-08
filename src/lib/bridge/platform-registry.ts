/**
 * 平台注册表（纯逻辑，无 I/O）。
 *
 * 稿台把「支持哪些平台、每个平台长什么样、能干什么」集中到这一份注册表，
 * 替代 protocol.ts 里硬编码的 PLATFORMS 数组，也作为后续适配器扩充与前端
 * 平台墙/筛选的基础。
 *
 * 元信息主要取自 Wechatsync 适配器（/tmp/Wechatsync/packages/core/src/
 * adapters/platforms/ 下每个适配器的 meta 字段，以及 types.ts 的
 * PlatformMeta 接口）；Wechatsync 未收录的平台（小红书、头条、抖音、大鱼、
 * 一点、网易、简书、值得买、搜狐焦点、WordPress、Typecho、X）按常识补齐，
 * capabilities 缺省为 ['article','draft']。
 *
 * 注意：本文件不引入任何 I/O，可被 Node 测试直接驱动。
 */

/** 平台分类。 */
export type PlatformCategory =
  | "mainstream" // 主流自媒体（微信/知乎/微博/小红书等）
  | "tech" // 技术社区（掘金/CSDN/SegmentFault等）
  | "general" // 通用（头条/简书/B站等）
  | "finance" // 财经（雪球/东方财富）
  | "cms" // 建站（WordPress/Typecho）
  | "overseas" // 海外（X/Twitter）
  | "special"; // 特殊（Hexo/Hugo 通过 Markdown 下载）

/** 平台能力（取自 Wechatsync PlatformCapability 子集，加封面等）。 */
export type PlatformCapability =
  | "article"
  | "draft"
  | "image_upload"
  | "tags"
  | "cover"
  | "categories";

/** 同步方式：API 调用 / DOM 填充 / 特殊（打包 Markdown 下载）。 */
export type SyncMode = "api" | "dom" | "zip-download";

/** 平台元信息。 */
export type PlatformMeta = {
  id: string;
  name: string;
  icon?: string;
  homepage: string;
  category: PlatformCategory;
  capabilities: PlatformCapability[];
  syncMode: SyncMode;
};

/** 注册表（31 个平台）。 */
const REGISTRY: PlatformMeta[] = [
  // ---- 主流自媒体（12） ----
  {
    id: "weixin",
    name: "微信公众号",
    icon: "https://mp.weixin.qq.com/favicon.ico",
    homepage: "https://mp.weixin.qq.com",
    category: "mainstream",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "zhihu",
    name: "知乎",
    icon: "https://static.zhihu.com/static/favicon.ico",
    homepage: "https://www.zhihu.com",
    category: "mainstream",
    capabilities: ["article", "draft", "image_upload", "tags", "cover"],
    syncMode: "api",
  },
  {
    id: "weibo",
    name: "微博",
    icon: "https://weibo.com/favicon.ico",
    homepage: "https://card.weibo.com/article/v5/editor",
    category: "mainstream",
    capabilities: ["article", "draft", "image_upload", "cover"],
    syncMode: "api",
  },
  {
    id: "xiaohongshu",
    name: "小红书",
    homepage: "https://www.xiaohongshu.com",
    category: "mainstream",
    capabilities: ["article", "draft"],
    syncMode: "api",
  },
  {
    id: "toutiao",
    name: "头条号",
    homepage: "https://mp.toutiao.com",
    category: "mainstream",
    capabilities: ["article", "draft"],
    syncMode: "api",
  },
  {
    id: "douyin",
    name: "抖音图文",
    homepage: "https://www.douyin.com",
    category: "mainstream",
    capabilities: ["article", "draft"],
    syncMode: "dom",
  },
  {
    id: "bilibili",
    name: "哔哩哔哩",
    icon: "https://www.bilibili.com/favicon.ico",
    homepage: "https://member.bilibili.com/platform/upload/text",
    category: "mainstream",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "api",
  },
  {
    id: "baijiahao",
    name: "百家号",
    icon: "https://www.baidu.com/favicon.ico",
    homepage: "https://baijiahao.baidu.com/",
    category: "mainstream",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "sohu",
    name: "搜狐号",
    icon: "https://mp.sohu.com/favicon.ico",
    homepage: "https://mp.sohu.com/mpfe/v3/main/first/page?newsType=1",
    category: "mainstream",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "dayu",
    name: "大鱼号",
    homepage: "https://mp.dayu.com",
    category: "mainstream",
    capabilities: ["article", "draft"],
    syncMode: "dom",
  },
  {
    id: "yidian",
    name: "一点号",
    homepage: "https://mp.yidian.com",
    category: "mainstream",
    capabilities: ["article", "draft"],
    syncMode: "dom",
  },
  {
    id: "netease",
    name: "网易号",
    homepage: "https://mp.163.com",
    category: "mainstream",
    capabilities: ["article", "draft"],
    syncMode: "dom",
  },

  // ---- 技术社区（8） ----
  {
    id: "juejin",
    name: "掘金",
    icon: "https://lf-web-assets.juejin.cn/obj/juejin-web/xitu_juejin_web/static/favicons/favicon-32x32.png",
    homepage: "https://juejin.cn",
    category: "tech",
    capabilities: ["article", "draft", "image_upload", "categories", "tags", "cover"],
    syncMode: "api",
  },
  {
    id: "csdn",
    name: "CSDN",
    icon: "https://g.csdnimg.cn/static/logo/favicon32.ico",
    homepage: "https://editor.csdn.net/md/",
    category: "tech",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "api",
  },
  {
    id: "segmentfault",
    name: "思否",
    icon: "https://imgcache.iyiou.com/Company/2016-05-11/cf-segmentfault.jpg",
    homepage: "https://segmentfault.com/user/draft",
    category: "tech",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "oschina",
    name: "开源中国",
    icon: "https://www.oschina.net/favicon.ico",
    homepage: "https://my.oschina.net",
    category: "tech",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "51cto",
    name: "51CTO",
    icon: "https://blog.51cto.com/favicon.ico",
    homepage: "https://blog.51cto.com/blogger/publish",
    category: "tech",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "imooc",
    name: "慕课手记",
    icon: "https://www.imooc.com/favicon.ico",
    homepage: "https://www.imooc.com/article",
    category: "tech",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "cnblogs",
    name: "博客园",
    icon: "https://www.cnblogs.com/favicon.ico",
    homepage: "https://www.cnblogs.com",
    category: "tech",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "yuque",
    name: "语雀",
    icon: "https://gw.alipayobjects.com/zos/rmsportal/UTjFYEzMSYVwzxIGVhMu.png",
    homepage: "https://www.yuque.com/dashboard",
    category: "tech",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "api",
  },

  // ---- 通用（5） ----
  {
    id: "jianshu",
    name: "简书",
    homepage: "https://www.jianshu.com",
    category: "general",
    capabilities: ["article", "draft"],
    syncMode: "dom",
  },
  {
    id: "douban",
    name: "豆瓣",
    icon: "https://www.douban.com/favicon.ico",
    homepage: "https://www.douban.com/topic/create?subtype=note",
    category: "general",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "woshipm",
    name: "人人都是产品经理",
    icon: "https://www.woshipm.com/favicon.ico",
    homepage: "https://www.woshipm.com",
    category: "general",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "smzdm",
    name: "什么值得买",
    homepage: "https://www.smzdm.com",
    category: "general",
    capabilities: ["article", "draft"],
    syncMode: "dom",
  },
  {
    id: "sohufocus",
    name: "搜狐焦点",
    homepage: "https://www.focus.cn",
    category: "general",
    capabilities: ["article", "draft"],
    syncMode: "dom",
  },

  // ---- 财经（2） ----
  {
    id: "xueqiu",
    name: "雪球",
    icon: "https://xqdoc.imedao.com/17aebcfb84a145d33fc18679.ico",
    homepage: "https://mp.xueqiu.com/writeV2",
    category: "finance",
    capabilities: ["article", "draft", "image_upload"],
    syncMode: "dom",
  },
  {
    id: "eastmoney",
    name: "东方财富",
    icon: "https://mp.eastmoney.com/collect/pc_article/favicon.ico",
    homepage: "https://mp.eastmoney.com",
    category: "finance",
    capabilities: ["article", "draft", "image_upload", "cover"],
    syncMode: "dom",
  },

  // ---- 建站（2） ----
  {
    id: "wordpress",
    name: "WordPress",
    homepage: "https://wordpress.org",
    category: "cms",
    capabilities: ["article", "draft"],
    syncMode: "api",
  },
  {
    id: "typecho",
    name: "Typecho",
    homepage: "https://typecho.org",
    category: "cms",
    capabilities: ["article", "draft"],
    syncMode: "dom",
  },

  // ---- 海外（1） ----
  {
    id: "x",
    name: "X/Twitter",
    homepage: "https://x.com",
    category: "overseas",
    capabilities: ["article", "draft"],
    syncMode: "dom",
  },

  // ---- 特殊（1） ----
  {
    id: "zip-download",
    name: "Markdown 压缩包",
    icon: "https://cdn-icons-png.flaticon.com/512/337/337946.png",
    homepage: "",
    category: "special",
    capabilities: ["article"],
    syncMode: "zip-download",
  },
];

/** 返回全部平台（按注册顺序）。 */
export function getAllPlatforms(): PlatformMeta[] {
  return REGISTRY;
}

/** 按 id 查平台，未注册返回 undefined。 */
export function getPlatformById(id: string): PlatformMeta | undefined {
  return REGISTRY.find((p) => p.id === id);
}

/** 按分类查平台（保持注册顺序）。 */
export function getPlatformsByCategory(cat: PlatformCategory): PlatformMeta[] {
  return REGISTRY.filter((p) => p.category === cat);
}

/**
 * 按关键字搜索平台（大小写不敏感）。
 * 匹配 id、name，以及 home 页/能力串。
 */
export function searchPlatforms(query: string): PlatformMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return REGISTRY;
  return REGISTRY.filter(
    (p) =>
      p.id.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.capabilities.some((c) => c.toLowerCase().includes(q)),
  );
}
