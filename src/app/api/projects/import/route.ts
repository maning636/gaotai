import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { createProject, saveStageResult, updateProject } from "../../../../lib/repo";
import { countHtmlTags, guessTitle, htmlToMarkdown } from "../../../../lib/html-to-md";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** 标题。留空就从文章里猜。 */
  title: z.string().trim().max(200).optional(),
  /** 文章正文。Markdown 或 HTML 都收。 */
  content: z.string().min(1, "先把文章贴进来。").max(2_000_000),
  topicId: z.string().trim().min(1).max(64),
});

/**
 * 导入一篇已有的文章。
 *
 * **只走最后一道工序**：文章直接进正文阶段，前面的材料解读、选题、大纲全跳过——
 * 文章已经是写好的，这三道工序对它没有意义。
 *
 * 导入之后这篇稿子照样能：选排版模板、看公众号预览、推草稿箱。
 *
 * HTML 会被洗成 Markdown（`htmlToMarkdown`）：稿台的渲染器遇到原始 HTML
 * 会转义成文字，用户从公众号后台复制来的文章直接贴会变成一堆 `&lt;p&gt;`。
 */
export async function POST(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体格式错误";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const raw = body.content;
    const htmlTags = countHtmlTags(raw);
    // 只有真的像 HTML 才洗一遍：纯 Markdown 过一遍转换器可能被误伤。
    const looksLikeHtml = /<\/?(p|div|section|h[1-6]|span|strong|em|img|br|ul|ol|li|a|blockquote|table|tr|td|th|figure)\b/i.test(raw);
    const markdown = looksLikeHtml ? htmlToMarkdown(raw) : raw;

    if (!markdown.trim()) {
      return NextResponse.json({ error: "这篇文章里没读到正文。" }, { status: 400 });
    }

    const title = body.title?.trim() || guessTitle(markdown);
    const project = createProject({ title, topicId: body.topicId });

    // 正文阶段直接落成「已签字」：文章就是定稿，没有再确认一遍的道理。
    saveStageResult({
      projectId: project.id,
      stage: "article",
      content: markdown,
      status: "confirmed",
    });
    const updated = updateProject(project.id, { stage: "article" });

    return NextResponse.json({
      project: updated,
      title,
      htmlTags,
      /** 洗过几处 HTML，界面上如实告诉用户。 */
      converted: looksLikeHtml && htmlTags > 0 ? htmlTags : 0,
      hanCount: (markdown.match(/[\u4e00-\u9fff]/g) ?? []).length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "导入失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
