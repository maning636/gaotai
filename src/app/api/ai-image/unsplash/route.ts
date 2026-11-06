import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "../../../../lib/license/guard";
import { searchPhotos, type UnsplashOrientation } from "../../../../lib/ai-image/unsplash";

export const runtime = "nodejs";

const querySchema = z.object({
  q: z.string().trim().min(1).max(120),
  page: z.coerce.number().int().min(1).max(50).optional(),
  orientation: z.enum(["landscape", "portrait", "squarish"]).optional(),
});

/**
 * Unsplash 搜索代理。
 *
 * 前端不接触 UNSPLASH_ACCESS_KEY：密钥在 unsplash.ts 里从环境变量读，这里只转发。
 */
export async function GET(request: Request) {
  const blocked = await guard();
  if (blocked) return blocked;

  const url = new URL(request.url);
  let query: z.infer<typeof querySchema>;
  try {
    query = querySchema.parse({
      q: url.searchParams.get("q") ?? "",
      page: url.searchParams.get("page") ?? undefined,
      orientation: url.searchParams.get("orientation") ?? undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "参数不对";
    return NextResponse.json({ error: `搜索参数不对：${message}` }, { status: 400 });
  }

  try {
    const photos = await searchPhotos(query.q, query.page ?? 1, query.orientation as UnsplashOrientation | undefined);
    return NextResponse.json({ photos });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unsplash 搜索失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
