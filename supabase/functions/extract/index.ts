// =====================================================================
//  extract ── レシピ抽出 Edge Function
//
//  mode:"url"   … ページを取得し JSON-LD(schema.org/Recipe) を解析して返す。
//                 見つからなければ本文テキストをそのまま返し、
//                 クライアント側のルールベース解析に回す（＝完全無料）。
//  mode:"image" … 画像からの読み取り。AI が必要なため、既定では無効。
//
//  ANTHROPIC_API_KEY は「任意」。
//    未設定 … AI を一切呼ばない。費用ゼロで動く（既定）
//    設定済 … JSON-LD が無いページと画像で Claude を使い、精度が上がる
//  クライアントにキーを渡すことは無い。
// =====================================================================

const MODEL = "claude-opus-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// ---------------------------------------------------------------------
// Claude に渡すレシピのスキーマ
// ---------------------------------------------------------------------
const RECIPE_TOOL = {
  name: "save_recipe",
  description: "抽出したレシピを構造化して保存する。",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "料理名。簡潔に。" },
      description: { type: "string", description: "ひとことでどんな料理か。無ければ空文字。" },
      servings: { type: "string", description: "何人分か。例「2人分」。不明なら空文字。" },
      prep_minutes: { type: "integer", description: "調理時間の目安(分)。不明なら 0。" },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "3〜6個。ジャンル(和食/洋食/中華/エスニック)、種類(主菜/副菜/汁物/主食/デザート)、特徴(時短/作り置き/お弁当/煮込み など)から選ぶ。",
      },
      ingredients: {
        type: "array",
        description: "材料。分量は原文の表記をそのまま使う。",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "材料名。例「玉ねぎ」" },
            amount: { type: "string", description: "分量。例「1/2個」「大さじ2」。不明なら「適量」" },
            group: { type: "string", description: "「A」「タレ」等のグループ名。無ければ空文字。" },
          },
          required: ["name", "amount", "group"],
          additionalProperties: false,
        },
      },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "手順。1手順1要素。番号は付けない。",
      },
    },
    required: ["title", "description", "servings", "prep_minutes", "tags", "ingredients", "steps"],
    additionalProperties: false,
  },
} as const;

const SYSTEM = `あなたは料理レシピを構造化するアシスタントです。
与えられた材料から日本語のレシピを抽出し、必ず save_recipe ツールを呼び出して返してください。
- 分量は原文の表記(大さじ・g・1/2個 など)をそのまま保つ。勝手に換算しない。
- 手順は調理者が読みやすいよう1手順ずつに分ける。冗長な前置きや宣伝文は落とす。
- 材料や手順が読み取れない部分は無理に創作せず、空配列や空文字にする。
- 読み取れた情報だけで save_recipe を呼ぶこと。ツールを使わず文章で答えてはいけない。
- 返答に内部用・システム用のXMLタグを含めないこと。`;

// ---------------------------------------------------------------------
// Anthropic 呼び出し
// ---------------------------------------------------------------------
const hasAI = () => !!Deno.env.get("ANTHROPIC_API_KEY");

async function callClaude(userContent: unknown[]): Promise<Record<string, unknown>> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("AI 機能は無効です");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "low" },
      tools: [RECIPE_TOOL],
      messages: [{ role: "user", content: userContent }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API エラー (${res.status}): ${data?.error?.message ?? JSON.stringify(data)}`);
  }

  // 通常ルート: tool_use ブロックを拾う
  for (const block of data.content ?? []) {
    if (block.type === "tool_use" && block.name === "save_recipe") {
      return block.input as Record<string, unknown>;
    }
  }
  // 保険: 文章で JSON を返してきた場合
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* fallthrough */ }
  }
  throw new Error(`レシピを読み取れませんでした (stop_reason: ${data.stop_reason})`);
}

// ---------------------------------------------------------------------
// JSON-LD (schema.org/Recipe) を探す
// ---------------------------------------------------------------------
function findRecipeNode(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findRecipeNode(n, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const t = obj["@type"];
  const types = Array.isArray(t) ? t : [t];
  if (types.includes("Recipe")) return obj;
  for (const k of ["@graph", "mainEntity", "itemListElement"]) {
    const hit = findRecipeNode(obj[k], depth + 1);
    if (hit) return hit;
  }
  return null;
}

const asText = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(" ");
  if (v && typeof v === "object") return asText((v as Record<string, unknown>).text ?? (v as Record<string, unknown>).name);
  return "";
};

// "PT25M" / "PT1H10M" → 分
function isoDurationToMinutes(v: unknown): number {
  const s = asText(v);
  const m = s.match(/^P(?:.*?T)?(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 60) + Number(m[2] ?? 0);
}

// 「玉ねぎ 1/2個」→ {name, amount}
function splitIngredient(line: string) {
  const s = line.replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?)[ 　:：]+([0-9０-９¼½¾一二三四五六七八九十][^ ]*.*|適量|少々|お好みで)$/);
  if (m) return { name: m[1].trim(), amount: m[2].trim(), group: "" };
  return { name: s, amount: "", group: "" };
}

function fromJsonLd(r: Record<string, unknown>) {
  const ing = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : [])
    .map(asText).filter(Boolean).map(splitIngredient);

  let steps: string[] = [];
  const inst = r.recipeInstructions;
  if (Array.isArray(inst)) {
    steps = inst.flatMap((s) => {
      const o = s as Record<string, unknown>;
      if (o && Array.isArray(o.itemListElement)) return (o.itemListElement as unknown[]).map(asText);
      return [asText(s)];
    }).filter(Boolean);
  } else {
    steps = asText(inst).split(/\n+/).map((x) => x.trim()).filter(Boolean);
  }

  const cat = [r.recipeCategory, r.recipeCuisine, r.keywords].flatMap((v) =>
    (Array.isArray(v) ? v : String(asText(v)).split(/[,、]/))
  ).map(asText).map((x) => x.trim()).filter(Boolean).slice(0, 6);

  let image = "";
  const img = r.image;
  if (typeof img === "string") image = img;
  else if (Array.isArray(img)) image = asText(img[0]) || String((img[0] as Record<string, unknown>)?.url ?? "");
  else if (img && typeof img === "object") image = String((img as Record<string, unknown>).url ?? "");

  return {
    title: asText(r.name),
    description: asText(r.description).slice(0, 200),
    servings: asText(r.recipeYield),
    prep_minutes: isoDurationToMinutes(r.totalTime) || isoDurationToMinutes(r.cookTime),
    tags: [...new Set(cat)],
    ingredients: ing,
    steps,
    image_url: image,
  };
}

// ---------------------------------------------------------------------
// HTML → 本文テキスト
// ---------------------------------------------------------------------
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, 20000);
}

// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST してください" }, 405);

  try {
    const body = await req.json();

    // ---------------- 画像から ----------------
    if (body.mode === "image") {
      if (!hasAI()) {
        return json({ error: "写真からの読み取りは AI(有料) が必要です。「📋 貼り付け」か「✏️ 手入力」をお使いください" }, 501);
      }
      if (!body.image) return json({ error: "画像がありません" }, 400);
      const recipe = await callClaude([
        {
          type: "image",
          source: {
            type: "base64",
            media_type: body.media_type ?? "image/jpeg",
            data: body.image,
          },
        },
        { type: "text", text: "この画像のレシピを読み取って save_recipe を呼び出してください。" },
      ]);
      return json({ recipe, via: "vision" });
    }

    // ---------------- URL から ----------------
    if (body.mode === "url") {
      const url = String(body.url ?? "").trim();
      if (!/^https?:\/\//.test(url)) return json({ error: "http(s) の URL を入れてください" }, 400);

      const page = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "accept-language": "ja,en;q=0.8",
        },
        redirect: "follow",
      });
      if (!page.ok) return json({ error: `ページを取得できませんでした (${page.status})` }, 502);
      const html = await page.text();

      // 1) JSON-LD を最優先（正確・APIコストゼロ）
      const scripts = [...html.matchAll(
        /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      )];
      for (const s of scripts) {
        try {
          const node = findRecipeNode(JSON.parse(s[1].trim()));
          if (node) {
            const r = fromJsonLd(node);
            if (r.title && r.ingredients.length) {
              return json({ recipe: r, via: "json-ld" });
            }
          }
        } catch { /* 次の script へ */ }
      }

      // 2) JSON-LD が無い場合
      const text = htmlToText(html);
      if (text.length < 50) return json({ error: "ページ本文を読み取れませんでした" }, 422);

      const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      const image_url = og ? og[1] : "";
      const tt = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const page_title = tt ? tt[1].replace(/\s+/g, " ").trim().slice(0, 80) : "";

      // AI が無効なら本文をそのまま返す。解析はクライアント側で行う（無料）
      if (!hasAI()) return json({ text, image_url, page_title, via: "text" });

      const recipe = await callClaude([
        { type: "text", text: `次のWebページからレシピを抽出してください。\n\nURL: ${url}\n\n---\n${text}` },
      ]);
      if (image_url) (recipe as Record<string, unknown>).image_url = image_url;
      return json({ recipe, via: "claude" });
    }

    return json({ error: "mode は url か image を指定してください" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
