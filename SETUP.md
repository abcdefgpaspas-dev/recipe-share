# セットアップ手順

> **急いで触りたいときは**、アプリを開いて「まず試してみる（この端末だけに保存）」を押してください。
> Supabase の設定なしで、サンプル入りの状態をすぐ試せます。以下はふたりで共有するための手順です。

やることは大きく 4 つです。**1〜3 はりょうさんのアカウントが必要なので、ご自身で実施してください。**

| | やること | 所要 |
|---|---|---|
| 1 | Supabase プロジェクトを作る（無料） | 5分 |
| 2 | テーブルを作る（SQL 貼り付け） | 2分 |
| 3 | ログイン用アカウントを 2 つ作る | 3分 |
| 4 | AI 取り込み用の Edge Function をデプロイ | 10分 |
| 5 | アプリを公開して iPhone に入れる | 10分 |

---

## 1. Supabase プロジェクトを作る

1. https://supabase.com/dashboard → **New project**
2. Name は何でもOK（例: `recipe-share`）
3. **Database Password** は控えておく
4. Region は `Northeast Asia (Tokyo)` を選ぶ
5. できたら **Project Settings → API** を開き、次の 2 つをメモ
   - **Project URL**（`https://xxxxxxxx.supabase.co`）
   - **anon public** キー（長い文字列）
   - ※ `service_role` キーは絶対にアプリに入れないこと

> anon キーは公開しても問題ありません。データは RLS（行レベルセキュリティ）で守られ、
> ログインしていない人は 1 件も読めません。

---

## 2. テーブルを作る

ダッシュボード左の **SQL Editor → New query** を開き、
`supabase/schema.sql` の中身を全部コピーして貼り付け、**Run**。

エラーが出なければ完了です。何度実行しても壊れません。

---

## 3. ログイン用アカウントを 2 つ作る

**Authentication → Users → Add user → Create new user**

- りょうさん用と、ひろみさん用で 2 つ作る
- メールアドレスとパスワードを入力
- **「Auto Confirm User」を ON** にする（確認メールを飛ばさずに済みます）

このプロジェクトにアカウントは 2 つしか存在しないので、
「ログインできた人 = 夫婦のどちらか」となり、これで十分安全です。

---

## 4. URL 取り込み（Edge Function）をデプロイ

URL を貼るとレシピが入る機能です。ブラウザは他サイトを直接読めない（CORS）ため、
ページを取ってくる中継役をサーバー側に置きます。**費用はかかりません**（無料枠内）。

> これを飛ばしても、「📋 貼り付け」と「✏️ 手入力」でアプリは使えます。
> あとから追加しても構いません。

### 4-1. Supabase CLI を入れる

```bash
brew install supabase/tap/supabase
```

### 4-2. ログインしてプロジェクトを紐づける

```bash
supabase login
```

```bash
cd ~/recipe-share && supabase link --project-ref あなたのproject-ref
```

`project-ref` は Project URL の `https://` と `.supabase.co` の間の文字列です。

### 4-3. デプロイ

```bash
cd ~/recipe-share && supabase functions deploy extract
```

うまくいかないときは、Supabase ダッシュボードの **Edge Functions → extract → Logs** に
エラーが出ているので確認してください。

### 補足: あとから AI を足したくなったら

いまの構成は AI を一切使いません。URL はページに埋め込まれたレシピ情報を読み、
無ければ本文をアプリ側が解析します。精度に不満が出たときだけ、下記でAIを有効化できます
（Anthropic の従量課金が発生します。1件あたり十数円程度）。

```bash
cd ~/recipe-share && supabase secrets set ANTHROPIC_API_KEY=sk-ant-ここにキー
```

キーを入れると Edge Function が自動で AI を使い始めます。コードの変更は不要です。
外したいときは `supabase secrets unset ANTHROPIC_API_KEY` で元に戻ります。

---

## 5. アプリを公開して iPhone に入れる

ひろみさんの iPhone からも使うので、インターネット上に置く必要があります。
**Cloudflare Pages** か **Netlify Drop** が簡単です（どちらも無料）。

### Netlify Drop（いちばん簡単・ドラッグ&ドロップだけ）

1. https://app.netlify.com/drop を開く
2. Finder で `~/recipe-share` フォルダをそのままブラウザにドラッグ
   （`supabase` フォルダは含まれていても害はありません）
3. `https://xxxx.netlify.app` の URL が発行される

### iPhone に入れる

1. Safari でその URL を開く
2. 共有ボタン → **ホーム画面に追加**
3. アプリを開くと「接続設定」画面が出るので、
   手順 1 でメモした **Project URL** と **anon public キー** を入力
4. 手順 3 で作ったメールアドレスとパスワードでログイン
5. 右上の ⚙︎ から **表示名と色** を決める
   （レシピに「● りょう」「● ひろみ」と誰が登録したかが出ます。
   ふたりで違う色にしておくと一目で分かります）

ひろみさんの iPhone でも、同じ URL を開いて同じ手順（別のアカウントでログイン）を行えば
同じレシピが見えます。

---

## 費用について

| | 費用 |
|---|---|
| Supabase 無料枠 | 500MB DB・1GB ストレージ。二人分のレシピなら当分無料 |
| Netlify / Cloudflare Pages | 無料 |
| Anthropic API | **使いません（0円）**。AI を足したい場合のみ従量課金 |

レシピサイトの多くは `schema.org/Recipe` の構造化データをページに埋めています。
Edge Function はまずそれを読むので、**その場合 AI を呼ばず＝課金ゼロ**です。
AI を使うのは「構造化データが無いページ」と「写真からの取り込み」のときだけです。

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| ログインできない | Users で「Auto Confirm User」が ON か確認。OFF だと確認メール待ちになります |
| レシピが 0 件のまま | 設定 → 「サーバーから再読み込み」。それでも駄目なら schema.sql の実行漏れ |
| URL 読み込みが失敗する | ログイン必須のサイト・JS で描画するサイトは取得できません。写真取り込みか手入力へ |
| URL 取り込みがうまくいかない | ログイン必須・JSで描画するサイトは読めません。ページの材料〜作り方をコピーして「📋 貼り付け」へ |
| 画像が表示されない | schema.sql の Storage 部分が実行されているか（バケット `recipe-images` が public か）確認 |
| 更新したのに古い画面が出る | ホーム画面のアプリを一度終了して開き直す（Service Worker のキャッシュ） |
