import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { resolveVideo } from "../../../../lib/videos";
import { uploadVideo } from "../../../../lib/wechat";
import { checkWechatConnection } from "../../../../lib/wechat-check";

export const runtime = "nodejs";
export const maxDuration = 300;

const bodySchema = z.object({
  /** 视频库里文件的相对路径。 */
  path: z.string().trim().min(1),
  /** 视频标题，微信要求非空。 */
  title: z.string().trim().min(1).max(100),
  /** 视频描述/简介，微信要求非空。 */
  description: z.string().trim().min(1).max(500),
});

/**
 * 把本地视频上传到微信永久素材库，拿回 media_id。
 *
 * 微信的视频素材走单独接口（media/uploadvideo），和图片的 add_material 不同：
 * 它要 title 和 introduction 两个字段拼成 JSON 放在 description 参数里。
 *
 * 上传完拿到 media_id 后，前端可以用它推一条视频消息草稿。
 * 这一步不在这里做——分开是因为上传很慢（200MB 的视频走家用宽带要好几分钟），
 * 推草稿是秒级的，用户不该在同一个请求里等两件事。
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
    const localPath = await resolveVideo(body.path);
    if (!localPath) {
      return NextResponse.json({ error: "视频文件不存在或路径非法。" }, { status: 404 });
    }

    // 先测通道，同推草稿一样——没测通就不浪费一次大文件上传。
    const check = await checkWechatConnection();
    if (!check.ok) {
      return NextResponse.json(
        { error: `公众号通道未通：${check.reason}。${check.hint}` },
        { status: 400 },
      );
    }

    const result = await uploadVideo({
      localPath,
      title: body.title,
      description: body.description,
    });
    return NextResponse.json({ ok: true, mediaId: result.mediaId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "上传视频到微信失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
