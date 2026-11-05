/* =====================================================================
   ふたりのレシピ帳
   Supabase の REST / Auth / Storage を素の fetch で叩く。ビルド不要。
   ===================================================================== */
'use strict';

const VERSION = '1.3.8';
const LS = {
  cfg: 'rs_cfg', session: 'rs_session', cache: 'rs_recipes',
  name: 'rs_name', checks: 'rs_checks', members: 'rs_members',
  local: 'rs_local', logs: 'rs_logs', queue: 'rs_queue',
};

// 表示名の色。ふたりで違う色を選べるように
const COLORS = ['#d9633b', '#4a89c4', '#5c8a4a', '#b8558f', '#c9a227', '#5f6f8a'];

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// http(s) の URL だけを許可し、CSS url() / 属性に安全な形に整える
function cssUrl(u) {
  const v = String(u || '');
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) return v;
  if (!/^https?:\/\//i.test(v)) return '';
  return encodeURI(String(u)).replace(/'/g, '%27').replace(/"/g, '%22')
    .replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// crypto.randomUUID は安全なコンテキスト(https か localhost)でしか存在しない。
// LAN の http:// でも動くように代替を持つ。
const uuid = () => (crypto?.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

// 日本語キーボードだと英数字が全角で入ることがある。
// 見た目は同じでもサーバーには別の文字列として届くため、半角に直す。
const toHalf = (v) => String(v ?? '')
  .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/\u3000/g, ' ');

const load = (k, d = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch { throw new Error('この端末の保存容量がいっぱいです。写真を減らすか、共有モードに切り替えてください'); }
};

let cfg      = load(LS.cfg);
let session  = load(LS.session);
let recipes  = load(LS.cache, []);
let members  = load(LS.members, []);   // [{id, name, color}]
// おためしモード = Supabase を使わず、この端末の localStorage だけで動かす
let localMode = load(LS.local, false);
const ME_LOCAL = 'local-me';
let editing  = null;   // 編集中レシピ(新規は null)
let current  = null;   // 詳細表示中レシピ
let filter   = { q: '', tag: '' };  // tag は '' / '★' / '@ユーザーID' / タグ名
let scale    = 1;

/* ---------------------------------------------------------------- UI */
function show(id) {
  $$('body > section').forEach((s) => s.classList.toggle('hidden', s.id !== id));
  window.scrollTo(0, 0);
}
function toast(msg, ms = 2200) {
  $$('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function showErr(where, msg) {
  const box = $(where);
  if (!box) return;
  box.innerHTML = msg ? `<div class="err">${esc(msg)}</div>` : '';
}
// 注意: 非同期ハンドラ内では e.currentTarget が await 後に null になる。
// 必ず await より前にボタンを変数に取ってから渡すこと。
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${esc(label || '処理中')}`; }
  else { btn.disabled = false; btn.innerHTML = btn.dataset.label || label || ''; }
}

/* ------------------------------------------------------------- 認証 */
async function login(email, password) {
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.msg || d.message || 'ログインできませんでした');
  session = d; save(LS.session, session);
}

// true: 更新できた / false: セッション切れ / 'offline': 通信できないだけ
async function refresh() {
  if (!session?.refresh_token) return false;
  let r;
  try {
    r = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
  } catch { return 'offline'; }
  if (!r.ok) return false;
  session = await r.json(); save(LS.session, session);
  return true;
}

function logout() {
  session = null; localStorage.removeItem(LS.session);
  recipes = []; localStorage.removeItem(LS.cache);
  show('v-login');
}

/* ------------------------------------------------- Supabase 呼び出し */
// 電波がない・サーバーに届かないときのエラー。これだけは「あとで送る」対象にする
const offlineErr = () => Object.assign(
  new Error('オフラインです。通信が戻ってからもう一度お試しください'), { offline: true });

async function call(path, opts = {}, retry = true) {
  // apikey は常に付ける。Authorization はログイン後のトークンだけを載せる。
  // （新形式の sb_publishable_... は JWT ではないため Bearer には使えない）
  const headers = { apikey: cfg.key, ...(opts.headers || {}) };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  if (opts.body && !(opts.body instanceof Blob) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (navigator.onLine === false) throw offlineErr();
  let r;
  try { r = await fetch(`${cfg.url}${path}`, { ...opts, headers }); }
  catch { throw offlineErr(); }
  if (r.status === 401 && retry) {
    const ok = await refresh();
    if (ok === true) return call(path, opts, false);
    if (ok === 'offline') throw offlineErr();
  }
  if (!r.ok) {
    let msg = `${r.status}`;
    try { const d = await r.json(); msg = d.message || d.error || d.hint || msg; } catch { /* noop */ }
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return r.status === 204 ? null : r.json();
}

/* ------------------------------------------- おためしモードの保存先 */
const L = {
  persist() { save(LS.cache, recipes); },
  list() { return [...recipes]; },
  // 行を作って返すだけ。recipes への追加と保存は呼び出し側が行う
  insert(row) {
    return { id: uuid(), created_at: new Date().toISOString(),
             favorite: false, cook_count: 0, last_cooked_on: null,
             created_by: ME_LOCAL, ...row };
  },
  update(id, patch) {
    const r = { ...recipes.find((x) => x.id === id), ...patch };
    recipes = recipes.map((x) => (x.id === id ? r : x));
    this.persist(); return r;
  },
  remove(id) { recipes = recipes.filter((r) => r.id !== id); this.persist(); return null; },
  logs() { return load(LS.logs, {}); },
  cooked(id) {
    const all = this.logs();
    const today = new Date().toISOString().slice(0, 10);
    all[id] = [...(all[id] || []), today];
    save(LS.logs, all);
    this.update(id, { cook_count: all[id].length, last_cooked_on: today });
    return null;
  },
  lastLog(id) {
    const days = this.logs()[id] || [];
    return days.length ? [{ id: String(days.length - 1), cooked_on: days[days.length - 1] }] : [];
  },
  uncook(idx, recipeId) {
    const all = this.logs();
    const days = (all[recipeId] || []).slice(0, -1);
    all[recipeId] = days; save(LS.logs, all);
    this.update(recipeId, { cook_count: days.length, last_cooked_on: days[days.length - 1] || null });
    return null;
  },
  members() { return load(LS.members, [{ id: ME_LOCAL, name: 'わたし', color: COLORS[0] }]); },
  member(name, color) {
    save(LS.members, [{ id: ME_LOCAL, name, color }]);
    return null;
  },
};

const db = {
  list:   ()      => localMode ? L.list() : call('/rest/v1/recipes?select=*&order=created_at.desc'),
  insert: (row)   => localMode ? L.insert(row)
    : call('/rest/v1/recipes', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) }).then((a) => a[0]),
  update: (id, p) => localMode ? L.update(id, p)
    : call(`/rest/v1/recipes?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(p) }).then((a) => a[0]),
  remove: (id)    => localMode ? L.remove(id) : call(`/rest/v1/recipes?id=eq.${id}`, { method: 'DELETE' }),
  one:    (id)    => call(`/rest/v1/recipes?id=eq.${id}&select=*`).then((a) => a[0]),
  cooked: (id)    => localMode ? L.cooked(id)
    : call('/rest/v1/cook_logs', { method: 'POST', body: JSON.stringify({ recipe_id: id, cooked_by: session?.user?.id ?? null }) }),
  lastLog: (id)   => localMode ? L.lastLog(id)
    : call(`/rest/v1/cook_logs?recipe_id=eq.${id}&select=id,cooked_on&order=created_at.desc&limit=1`),
  uncook: (logId, recipeId) => localMode ? L.uncook(logId, recipeId)
    : call(`/rest/v1/cook_logs?id=eq.${logId}`, { method: 'DELETE' }),
  members: ()     => localMode ? L.members() : call('/rest/v1/members?select=id,name,color'),
  member: (name, color) => localMode ? L.member(name, color)
    : call('/rest/v1/members', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ id: session.user.id, name, color }),
      }),
};

/* ------------------------------------- オフライン時の送信待ちキュー
   共有モードで通信できないときは、変更を端末に貯めておき、
   通信が戻ったら古い順にサーバーへ送る。 */
const Q = {
  get() { return load(LS.queue, []); },
  set(q) { save(LS.queue, q); },
  // 同じレシピへの変更はなるべく1件にまとめる
  add(op) {
    let q = this.get();
    op.qid = uuid(); op.ts = new Date().toISOString();
    if (op.type === 'update') {
      const prev = q.find((x) => x.id === op.id && (x.type === 'insert' || x.type === 'update'));
      if (prev?.type === 'insert') { prev.row = { ...prev.row, ...op.patch }; return this.set(q); }
      if (prev) { prev.patch = { ...prev.patch, ...op.patch }; return this.set(q); }
    }
    if (op.type === 'remove') {
      const neverSent = q.some((x) => x.id === op.id && x.type === 'insert');
      q = q.filter((x) => x.id !== op.id);
      if (neverSent) return this.set(q);   // まだ送っていない新規なら消すだけで済む
    }
    q.push(op); this.set(q);
  },
  drop(qid) { this.set(this.get().filter((x) => x.qid !== qid)); },
};
const pendingIds = () => new Set(Q.get().map((x) => x.id));
const today = () => new Date().toISOString().slice(0, 10);

// 送信待ちの変更をサーバーのデータに重ねる（送るまで画面から消えないように）
function applyQueue(list) {
  let out = [...list];
  for (const op of Q.get()) {
    if (op.type === 'insert' && !out.some((r) => r.id === op.id)) {
      out.unshift({ created_at: op.ts, favorite: false, cook_count: 0, last_cooked_on: null, ...op.row });
    } else if (op.type === 'update') {
      out = out.map((r) => (r.id === op.id ? { ...r, ...op.patch } : r));
    } else if (op.type === 'remove') {
      out = out.filter((r) => r.id !== op.id);
    } else if (op.type === 'cooked') {
      out = out.map((r) => (r.id === op.id
        ? { ...r, cook_count: (r.cook_count || 0) + 1, last_cooked_on: op.cooked_on } : r));
    }
  }
  return out;
}

// data: URL の画像は送信前に Storage へ上げて URL に置き換える
async function uploadInline(obj) {
  if (!/^data:image\//.test(obj?.image_url || '')) return obj;
  const blob = await (await fetch(obj.image_url)).blob();
  return { ...obj, image_url: await putImage(blob) };
}

async function sendOp(op) {
  if (op.type === 'insert') {
    const row = await uploadInline(op.row);
    // 届いたのに返事だけ失敗した場合の再送でも二重登録にならないよう upsert
    return call('/rest/v1/recipes?on_conflict=id', {
      method: 'POST', headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify(row),
    });
  }
  if (op.type === 'update') return db.update(op.id, await uploadInline(op.patch));
  if (op.type === 'remove') return db.remove(op.id);
  if (op.type === 'cooked') {
    return call('/rest/v1/cook_logs', { method: 'POST',
      body: JSON.stringify({ recipe_id: op.id, cooked_by: op.cooked_by, cooked_on: op.cooked_on }) });
  }
}

let flushing = null;
// 送信できた件数を返す
function flush() {
  if (localMode || !session?.access_token) return Promise.resolve(0);
  return (flushing ||= (async () => {
    let sent = 0;
    for (const op of Q.get()) {
      try { await sendOp(op); Q.drop(op.qid); sent++; }
      catch (e) {
        // 通信できない・ログイン切れは、そのまま残して次の機会に再送
        if (e.offline || e.status === 401) break;
        // サーバーに拒否された変更（すでに削除済みなど）は詰まらないよう捨てる
        Q.drop(op.qid);
        toast(`送れなかった変更があります: ${e.message}`, 4000);
      }
    }
    return sent;
  })().finally(() => { flushing = null; }));
}

let lastQueued = false;
// サーバーへ送る。通信できなければキューに積んで、画面用の結果を返す
async function remote(op, send, local) {
  lastQueued = false;
  if (localMode) return send();
  if (Q.get().length) await flush();       // 順番を守るため、先に古い変更を送る
  if (!Q.get().length) {
    try { return await send(); } catch (e) { if (!e.offline) throw e; }
  }
  Q.add(op); lastQueued = true;
  return local();
}

const rdb = {
  insert(row) {
    if (localMode) return db.insert(row);
    const r = { ...row, id: uuid() };
    return remote({ type: 'insert', id: r.id, row: r }, () => sendOp({ type: 'insert', row: r }).then(() => db.one(r.id)),
      () => applyQueue([]).find((x) => x.id === r.id));
  },
  update(id, patch) {
    return remote({ type: 'update', id, patch }, () => sendOp({ type: 'update', id, patch }),
      () => ({ ...recipes.find((x) => x.id === id), ...patch }));
  },
  remove(id) {
    return remote({ type: 'remove', id }, () => db.remove(id), () => null);
  },
  cooked(id) {
    const op = { type: 'cooked', id, cooked_by: session?.user?.id ?? null, cooked_on: today() };
    return remote(op, () => db.cooked(id), () => {
      recipes = recipes.map((r) => (r.id === id
        ? { ...r, cook_count: (r.cook_count || 0) + 1, last_cooked_on: op.cooked_on } : r));
      save(LS.cache, recipes);
    });
  },
};

async function uploadImage(blob) {
  if (localMode) {
    // 端末内保存。容量を食わないよう小さめに作り直す
    const small = await shrink(new File([blob], 'p.jpg', { type: 'image/jpeg' }), 900, 0.7);
    return 'data:image/jpeg;base64,' + await blobToBase64(small);
  }
  try { return await putImage(blob); }
  catch (e) {
    if (!e.offline) throw e;
    // オフライン中は端末内に小さく持っておき、送信時にアップロードする
    const small = await shrink(new File([blob], 'p.jpg', { type: 'image/jpeg' }), 900, 0.7);
    return 'data:image/jpeg;base64,' + await blobToBase64(small);
  }
}

async function putImage(blob) {
  if (navigator.onLine === false) throw offlineErr();
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  let r;
  try {
    r = await fetch(`${cfg.url}/storage/v1/object/recipe-images/${path}`, {
      method: 'POST',
      headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
      body: blob,
    });
  } catch { throw offlineErr(); }
  if (!r.ok) throw Object.assign(new Error('画像をアップロードできませんでした'), { status: r.status });
  return `${cfg.url}/storage/v1/object/public/recipe-images/${path}`;
}

async function extract(payload) {
  if (localMode) {
    throw new Error('URL の読み取りには Supabase の設定が必要です。ページの材料と作り方をコピーして「📋 貼り付け」に貼ってください');
  }
  const r = await fetch(`${cfg.url}/functions/v1/extract`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `読み込みに失敗しました (${r.status})`);
  return d;
}

/* --------------------------------------------------------- 画像処理 */
async function shrink(file, max = 1400, q = 0.82) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((res) => c.toBlob(res, 'image/jpeg', q));
}
const blobToBase64 = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = rej;
  fr.readAsDataURL(blob);
});

/* ------------------------------------------------- レシピ文の解析 */
// Web ページの本文や、iOS の文字認識でコピーした文章から
// 材料・手順を取り出す。AI を使わないルールベース。
const RE_ING_HEAD  = /^[■□◆◇●○・\[【\s]*材\s*料|^ingredients\b/i;
const RE_STEP_HEAD = /^[■□◆◇●○・\[【\s]*(作\s*り\s*方|つくり方|作りかた|手\s*順|調理手順)|^(instructions|directions|method|steps)\b/i;
const RE_AMT = /(大さじ|小さじ|カップ|[0-9０-９¼½¾]|少々|適量|適宜|お好み|ひとつまみ)/;

// 「しょうゆ 大さじ2」→ {name:'しょうゆ', amount:'大さじ2'}
function splitIng(line) {
  let s = line.replace(/[.．]{2,}/g, ' ').replace(/[…‥]+/g, ' ')
              .replace(/[\s　]+/g, ' ').trim();
  let group = '';
  const g = s.match(/^([A-Za-zＡ-Ｚ☆★●○◎◇◆]|【[^】]{1,4}】)[\s:：]*(.+)$/);
  if (g && /[ぁ-んァ-ヶ一-龥]/.test(g[2])) { group = g[1].replace(/[【】]/g, ''); s = g[2].trim(); }
  const i = s.search(RE_AMT);
  if (i > 0) return { name: s.slice(0, i).replace(/[\s:：]+$/, ''), amount: s.slice(i).trim(), group };
  const sp = s.match(/^(.+)\s(\S+)$/);
  if (sp) return { name: sp[1].trim(), amount: sp[2].trim(), group };
  return { name: s, amount: '', group };
}

// 「材料」「作り方」の見出しがある文章を分解する。無ければ null
function parseWithHeadings(lines) {
  const r = { title: '', servings: '', ingredients: [], steps: [], tags: [] };
  let mode = 'head', sawIng = false;
  for (const l of lines) {
    if (RE_ING_HEAD.test(l)) {
      mode = 'ing'; sawIng = true;
      const m = l.match(/[（(]([^）)]{1,12})[）)]/) || l.match(/([0-9０-９]+\s*[〜～-]?\s*[0-9０-９]*\s*人分)/);
      if (m) r.servings = m[1].trim();
      continue;
    }
    if (RE_STEP_HEAD.test(l)) { mode = 'step'; continue; }
    if (mode === 'head') {
      if (!r.title && l.length <= 40) r.title = l.replace(/^[#＃\s]+/, '');
      continue;
    }
    if (mode === 'ing') {
      const ing = splitIng(stripBullet(l));
      if (ing.name) r.ingredients.push(ing);
    } else {
      pushStep(r.steps, l);
    }
  }
  return (sawIng && r.ingredients.length) ? r : null;
}

// 分量らしき表記を含む短い行を「材料」とみなす
const RE_UNIT = /([0-9０-９]+\s*(g|ｇ|kg|mg|ml|ｍｌ|cc|L|個|本|枚|玉|丁|袋|片|尾|杯|合|束|株|房|缶|パック|切れ|cm|センチ)|大さじ|小さじ|カップ|少々|適量|適宜|ひとつまみ|お好み)/;
function looksIngredient(l) {
  if (l.length > 30 || /[。！？]$/.test(l)) return false;
  return RE_UNIT.test(l);
}

// 見出しが無い文章でも、行の見た目から材料と手順に振り分ける
function parseLoose(lines) {
  const r = { title: '', servings: '', ingredients: [], steps: [], tags: [] };
  for (const l of lines) {
    const sv = l.match(/([0-9０-９]+\s*人分)/);
    if (sv && !r.servings) r.servings = sv[1];
    if (!r.title && l.length <= 30 && !RE_UNIT.test(l) && !/[。、]$/.test(l)) { r.title = cleanTitle(l); continue; }
    if (looksIngredient(l)) {
      const ing = splitIng(stripBullet(l));
      if (ing.name) r.ingredients.push(ing);
    } else {
      pushStep(r.steps, l);
    }
  }
  return (r.ingredients.length || r.steps.length) ? r : null;
}

const stripBullet = (l) => l.replace(/^[・･\-–—*＊○●□■\s]+/, '');

// 文章の中に埋もれた「ピーマン4個」「ごま油小さじ2」を拾う。
// 行単位で材料が1つも取れなかったときの最後の手段。
const RE_MINE = /([ぁ-んァ-ヶー一-龥A-Za-z]{2,12}?)\s*((?:大さじ|小さじ)\s*[0-9０-９]+(?:\/[0-9０-９]+)?|[0-9０-９]+(?:\/[0-9０-９]+)?\s*(?:g|ｇ|kg|ml|ｍｌ|cc|個|本|枚|玉|丁|袋|片|尾|杯|合|束|株|房|缶|パック|切れ))/g;
function mineIngredients(text) {
  const out = [], seen = new Set();
  for (const m of text.matchAll(RE_MINE)) {
    // 「とごま油」のように助詞がくっつくので落とす
    const name = m[1].trim().replace(/^[とやをにではがのもへ、。・]+/, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, amount: m[2].replace(/\s+/g, ''), group: '' });
    if (out.length >= 15) break;
  }
  return out;
}

// 「無限ピーマンの作り方です。」→「無限ピーマン」
const cleanTitle = (l) => l.replace(/[。！\.]+$/, '').replace(/です$/, '')
  .replace(/(の)?(作\s*り\s*方|つくり方|レシピ)$/, '').trim().slice(0, 40);

// 手順の行頭の番号を落とす。長すぎる行は「。」で分ける
function pushStep(arr, line) {
  const t = line.replace(/^[(（\[［]?\s*[0-9０-９]{1,2}\s*[).．、\]］）:：]\s*/, '')
                .replace(/^[①-⑳❶-❿]\s*/, '')
                .replace(/^(手順|step)\s*[0-9０-９]+\s*[.:：、]?\s*/i, '').trim();
  if (!t) return;
  if (t.length > 90 && t.includes('。')) {
    t.split('。').map((x) => x.trim()).filter(Boolean).forEach((x) => arr.push(x + '。'));
  } else arr.push(t);
}

// 貼り付けられた文章を解析する。まず見出しで、だめなら見た目で判断する
function parseRecipeText(src) {
  const text = String(src).replace(/\r/g, '').replace(/\u3000/g, ' ');
  let lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // 改行の無い一続きの文章は「。」で区切ってから扱う
  if (lines.length <= 2 && text.length > 80) {
    lines = text.split('。').map((l) => l.trim()).filter(Boolean).map((l) => l + '。');
  }
  if (!lines.length) return null;
  const r = parseWithHeadings(lines) || parseLoose(lines);
  if (!r) return null;
  // 材料が拾えていなければ、文章の中から探す
  if (!r.ingredients.length) r.ingredients = mineIngredients(text);
  // 題名が空なら1行目から作る
  if (!r.title) r.title = cleanTitle(lines[0]);
  return r;
}

/* ------------------------------------------------------- 分量の換算 */
function fmtNum(v) {
  const r = Math.round(v * 100) / 100;
  const near = (x) => Math.abs(r - x) < 1e-6;
  if (near(0.25)) return '1/4';
  if (near(0.5))  return '1/2';
  if (near(0.75)) return '3/4';
  if (near(1.5))  return '1.5';
  return String(r);
}
function scaleAmount(s, f) {
  if (f === 1 || !s) return s || '';
  return String(s).replace(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)|(\d+(?:\.\d+)?)/g,
    (_m, a, b, c) => fmtNum((b ? Number(a) / Number(b) : Number(c)) * f));
}

/* ---------------------------------------------------------- 作成者 */
const myId = () => (localMode ? ME_LOCAL : (session?.user?.id ?? null));
const memberOf = (id) => members.find((m) => m.id === id) || null;

// 「● りょう」「● ひろみ」のバッジ。作成者が分からないときは空文字
function whoBadge(id, withName = true) {
  const m = memberOf(id);
  if (!m || !m.name) return '';
  const c = /^#[0-9a-f]{3,8}$/i.test(m.color || '') ? m.color : 'var(--tx3)';
  return `<span class="who"><i style="background:${c}"></i>${withName ? esc(m.name) : ''}</span>`;
}

// 自分の members 行が無ければ、メールアドレスから仮の名前で作っておく
async function ensureMember() {
  const me = memberOf(myId());
  if (me?.name) { save(LS.name, me.name); return; }
  const guess = load(LS.name, '') || (session?.user?.email || '').split('@')[0] || 'わたし';
  if (localMode) { await db.member(guess, COLORS[0]); members = await db.members(); return save(LS.name, guess); }
  const color = COLORS[members.length % COLORS.length];
  try {
    await db.member(guess, color);
    save(LS.name, guess);
    members = await db.members(); save(LS.members, members);
  } catch { /* 名前が付かなくても本体は使える */ }
}

/* ============================== 一覧 ============================== */
function matches(r, q) {
  if (!q) return true;
  const hay = [
    r.title, r.description, r.memo, (r.tags || []).join(' '),
    (r.ingredients || []).map((i) => i.name).join(' '),
  ].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function renderTags() {
  const counts = {};
  recipes.forEach((r) => (r.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 24);
  // 1件でも登録があるメンバーだけ絞り込みチップに出す
  const who = members.filter((m) => m.name && recipes.some((r) => r.created_by === m.id));

  $('#tagbar').innerHTML =
    `<button class="chip ${filter.tag === '' ? 'on' : ''}" data-tag="">すべて</button>` +
    `<button class="chip ${filter.tag === '★' ? 'on' : ''}" data-tag="★">★ お気に入り</button>` +
    who.map((m) => `<button class="chip ${filter.tag === '@' + m.id ? 'on' : ''}" data-tag="@${esc(m.id)}">${whoBadge(m.id)}</button>`).join('') +
    tags.map((t) => `<button class="chip ${filter.tag === t ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
}

function renderList() {
  renderTags();
  let rows = recipes.filter((r) => matches(r, filter.q));
  if (filter.tag === '★') rows = rows.filter((r) => r.favorite);
  else if (filter.tag.startsWith('@')) rows = rows.filter((r) => r.created_by === filter.tag.slice(1));
  else if (filter.tag) rows = rows.filter((r) => (r.tags || []).includes(filter.tag));

  const box = $('#list');
  if (!rows.length) {
    box.innerHTML = recipes.length
      ? '<div class="empty">見つかりませんでした</div>'
      : '<div class="empty">まだレシピがありません<br>右下の ＋ から追加してください</div>';
    return;
  }
  const pend = pendingIds();
  box.innerHTML = `<div class="grid">${rows.map((r) => `
    <button class="rc" data-id="${r.id}" style="position:relative">
      ${r.favorite ? '<span class="fav">★</span>' : ''}
      <div class="thumb" style="${r.image_url ? `background-image:url('${cssUrl(r.image_url)}')` : ''}">${r.image_url ? '' : '🍳'}</div>
      <div class="body">
        <h3>${esc(r.title)}</h3>
        <div style="display:flex;gap:4px;flex-wrap:wrap">${(r.tags || []).slice(0, 2).map((t) => `<span class="tg">${esc(t)}</span>`).join('')}</div>
        <div class="meta">
          ${whoBadge(r.created_by)}
          ${r.prep_minutes ? `<span>⏱ ${r.prep_minutes}分</span>` : ''}
          ${r.cook_count ? `<span>🍽 ${r.cook_count}回</span>` : ''}
          ${pend.has(r.id) ? '<span title="通信が戻ったら自動で送信します">⏳ 未送信</span>' : ''}
        </div>
      </div>
    </button>`).join('')}</div>`;
}

async function sync() {
  if (localMode) {
    members = await db.members(); save(LS.members, members);
    await ensureMember();
    return renderList();
  }
  try {
    const sent = await flush();
    if (sent) toast(`オフライン中の変更 ${sent}件を送信しました`);
    const [rs, ms] = await Promise.all([db.list(), db.members()]);
    recipes = applyQueue(rs); members = ms;
    save(LS.cache, recipes); save(LS.members, members);
    await ensureMember();
    renderList();
    if (current) { current = recipes.find((r) => r.id === current.id) || current; }
  } catch (e) {
    renderList();
    toast(recipes.length ? 'オフライン表示中' : `読み込みに失敗しました: ${e.message}`);
  }
}

/* ============================== 詳細 ============================== */
function renderDetail(r) {
  current = r; scale = 1;
  const checks = load(LS.checks, {})[r.id] || [];
  $('#d-fav').textContent = r.favorite ? '★' : '☆';

  const ings = (r.ingredients || []).map((ing, i) => `
    <div class="ing ${checks.includes(i) ? 'done' : ''}" data-i="${i}">
      <span class="gp">${esc(ing.group || '')}</span>
      <span class="nm">${esc(ing.name)}</span>
      <span class="am">${esc(scaleAmount(ing.amount, scale))}</span>
    </div>`).join('') || '<p class="note">材料は登録されていません</p>';

  const steps = (r.steps || []).map((s, i) =>
    `<div class="step"><b>${i + 1}</b><div>${esc(typeof s === 'string' ? s : s.text)}</div></div>`
  ).join('') || '<p class="note">手順は登録されていません</p>';

  $('#detail').innerHTML = `
    <div class="hero" style="${r.image_url ? `background-image:url('${cssUrl(r.image_url)}')` : ''}">${r.image_url ? '' : '🍳'}</div>
    <h2 class="dt">${esc(r.title)}</h2>
    ${r.description ? `<p class="note" style="margin-bottom:12px">${esc(r.description)}</p>` : ''}
    <div class="dmeta">
      ${whoBadge(r.created_by) ? `<span class="pill">${whoBadge(r.created_by)} が登録</span>` : ''}
      ${r.servings ? `<span class="pill">👥 ${esc(r.servings)}</span>` : ''}
      ${r.prep_minutes ? `<span class="pill">⏱ ${r.prep_minutes}分</span>` : ''}
      ${r.cook_count ? `<span class="pill">🍽 ${r.cook_count}回目</span>` : ''}
      ${r.last_cooked_on ? `<span class="pill">最終 ${esc(r.last_cooked_on)}</span>` : ''}
      ${(r.tags || []).map((t) => `<span class="pill">${esc(t)}</span>`).join('')}
    </div>

    <div class="dact">
      <button class="btn pri wide" id="d-cooked">🍽 作った</button>
      <button class="btn" id="d-edit">編集</button>
    </div>
    ${r.cook_count ? '<button class="undo" id="d-uncook">直近の「作った」を取り消す</button>' : ''}

    <div class="sec"><h3>材料</h3><div class="line"></div>
      <div class="scaler">
        ${[0.5, 1, 2].map((f) => `<button data-f="${f}" class="${f === scale ? 'on' : ''}">×${f}</button>`).join('')}
      </div>
    </div>
    <div id="inglist">${ings}</div>

    <div class="sec"><h3>手順</h3><div class="line"></div></div>
    ${steps}

    ${r.memo ? `<div class="sec"><h3>うちの味メモ</h3><div class="line"></div></div><div class="memo">${esc(r.memo)}</div>` : ''}

    ${cssUrl(r.source_url) ? `<p class="note" style="margin-top:24px">元ページ: <a href="${cssUrl(r.source_url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(r.source_url.slice(0, 60))}</a></p>` : ''}
    <button class="btn wide danger sm" id="d-del" style="margin:28px 0 10px">このレシピを削除</button>`;

  show('v-detail');
}

function rerenderIngredients() {
  const r = current;
  const checks = load(LS.checks, {})[r.id] || [];
  $('#inglist').innerHTML = (r.ingredients || []).map((ing, i) => `
    <div class="ing ${checks.includes(i) ? 'done' : ''}" data-i="${i}">
      <span class="gp">${esc(ing.group || '')}</span>
      <span class="nm">${esc(ing.name)}</span>
      <span class="am">${esc(scaleAmount(ing.amount, scale))}</span>
    </div>`).join('');
  $$('.scaler button').forEach((b) => b.classList.toggle('on', Number(b.dataset.f) === scale));
}

/* ============================ 追加・編集 ============================ */
const MV = `<span class="mv"><button type="button" data-mv="-1" title="上へ">▲</button>
              <button type="button" data-mv="1" title="下へ">▼</button></span>`;

function ingRow(v = { name: '', amount: '', group: '' }) {
  const d = document.createElement('div');
  d.className = 'lrow';
  d.innerHTML = `<input class="ing-n" placeholder="材料" value="${esc(v.name)}">
                 <input class="ing-a" placeholder="分量" value="${esc(v.amount)}">
                 ${MV}<button class="del" type="button" data-del>×</button>`;
  d.dataset.group = v.group || '';
  return d;
}
function stepRow(text = '', n = 1) {
  const d = document.createElement('div');
  d.className = 'lrow srow';
  d.innerHTML = `<span class="sn">${n}</span>
                 <textarea placeholder="手順">${esc(text)}</textarea>
                 ${MV}<button class="del" type="button" data-del>×</button>`;
  return d;
}
const renumber = () => $$('#steps .sn').forEach((s, i) => { s.textContent = i + 1; });

// 材料・手順の行を上下に動かす／消す（イベント委譲）
function rowListClick(e) {
  const row = e.target.closest('.lrow');
  if (!row) return;
  if (e.target.closest('[data-del]')) { row.remove(); return renumber(); }
  const mv = e.target.closest('[data-mv]');
  if (!mv) return;
  const p = row.parentElement;
  if (Number(mv.dataset.mv) < 0) { if (row.previousElementSibling) p.insertBefore(row, row.previousElementSibling); }
  else if (row.nextElementSibling) p.insertBefore(row.nextElementSibling, row);
  renumber();
}

function openEditor(r) {
  editing = r;
  showErr('#ext-err', '');
  $('#edit-title').textContent = r ? 'レシピを編集' : 'レシピを追加';
  $('#src-tabs').classList.toggle('hidden', !!r);
  setTab('manual');

  const d = r || { ingredients: [{}, {}, {}], steps: ['', ''] };
  $('#f-title').value = d.title || '';
  $('#f-desc').value  = d.description || '';
  $('#f-serv').value  = d.servings || '';
  $('#f-min').value   = d.prep_minutes || '';
  $('#f-tags').value  = (d.tags || []).join(', ');
  $('#f-memo').value  = d.memo || '';
  $('#form').dataset.image = d.image_url || '';
  $('#photo-drop').innerHTML = d.image_url
    ? `<img src="${cssUrl(d.image_url)}" style="max-height:150px;border-radius:10px">`
    : '<b>🖼</b>写真を選ぶ';

  $('#ings').innerHTML = '';
  (d.ingredients?.length ? d.ingredients : [{}, {}, {}]).forEach((i) => $('#ings').append(ingRow(i)));
  $('#steps').innerHTML = '';
  (d.steps?.length ? d.steps : ['', '']).forEach((s, i) =>
    $('#steps').append(stepRow(typeof s === 'string' ? s : s.text, i + 1)));

  show('v-edit');
}

function fillForm(x) {
  if (x.title) $('#f-title').value = x.title;
  if (x.description) $('#f-desc').value = x.description;
  if (x.servings) $('#f-serv').value = x.servings;
  if (x.prep_minutes) $('#f-min').value = x.prep_minutes;
  if (x.tags?.length) $('#f-tags').value = x.tags.join(', ');
  if (x.image_url && !$('#form').dataset.image) {
    $('#form').dataset.image = x.image_url;
    $('#photo-drop').innerHTML = `<img src="${cssUrl(x.image_url)}" style="max-height:150px;border-radius:10px">`;
  }
  if (x.ingredients?.length) {
    $('#ings').innerHTML = '';
    x.ingredients.forEach((i) => $('#ings').append(ingRow(i)));
  }
  if (x.steps?.length) {
    $('#steps').innerHTML = '';
    x.steps.forEach((s, i) => $('#steps').append(stepRow(typeof s === 'string' ? s : s.text, i + 1)));
  }
  setTab('manual');
  toast('読み込みました。内容を確認して保存してください');
}

function readForm() {
  const ingredients = $$('#ings .lrow').map((row) => ({
    name:   row.querySelector('.ing-n').value.trim(),
    amount: row.querySelector('.ing-a').value.trim(),
    group:  row.dataset.group || '',
  })).filter((i) => i.name);
  const steps = $$('#steps textarea').map((t) => t.value.trim()).filter(Boolean);
  const tags = $('#f-tags').value.split(/[,、]/).map((t) => t.trim()).filter(Boolean);
  return {
    title: $('#f-title').value.trim(),
    description: $('#f-desc').value.trim(),
    servings: $('#f-serv').value.trim(),
    prep_minutes: Number($('#f-min').value) || null,
    tags, ingredients, steps,
    memo: $('#f-memo').value.trim(),
    image_url: $('#form').dataset.image || null,
  };
}

function setTab(src) {
  applyMode();
  $$('#src-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.src === src));
  $('#pane-url').classList.toggle('hidden', src !== 'url');
  $('#pane-paste').classList.toggle('hidden', src !== 'paste');
  $('#form').classList.toggle('hidden', false);
  $('#form').dataset.src = src;
}

/* ============================ イベント ============================ */
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-back]')) return;
  const cur = $$('body > section').find((s) => !s.classList.contains('hidden'));
  // 既存レシピの編集中だけ詳細に戻る。それ以外は一覧へ。
  if (cur?.id === 'v-edit' && editing && current) renderDetail(current);
  else { show('v-list'); renderList(); }
});

// --- 設定
$('#cfg-save').onclick = () => {
  const url = toHalf($('#cfg-url').value).trim().replace(/\/+$/, '');
  const key = toHalf($('#cfg-key').value).trim();
  if (!/^https:\/\/.+/.test(url) || key.length < 20) {
    return showErr('#setup-err', 'URL と anon キーを正しく入れてください');
  }
  cfg = { url, key }; save(LS.cfg, cfg);
  showErr('#setup-err', '');
  show('v-login');
};

// --- おためしモード
const SAMPLES = [
  { title: '肉じゃが', description: '定番。多めに作って翌日も', servings: '2人分', prep_minutes: 35,
    tags: ['和食', '主菜', '煮込み'],
    ingredients: [
      { name: '牛こま切れ肉', amount: '200g', group: '' },
      { name: 'じゃがいも', amount: '3個', group: '' },
      { name: '玉ねぎ', amount: '1/2個', group: '' },
      { name: 'にんじん', amount: '1本', group: '' },
      { name: 'しょうゆ', amount: '大さじ3', group: 'A' },
      { name: 'みりん', amount: '大さじ2', group: 'A' },
      { name: '砂糖', amount: '大さじ1', group: 'A' },
      { name: '水', amount: '300ml', group: 'A' },
    ],
    steps: ['じゃがいもは皮をむいて一口大、にんじんは乱切り、玉ねぎはくし切りにする。',
            '鍋に油を熱し、牛肉を色が変わるまで炒める。',
            '野菜を加えて全体に油がまわるまで炒める。',
            'Aを加え、煮立ったらアクを取って落とし蓋をし、弱めの中火で15分煮る。',
            '火を止めて10分置くと味がしみる。'],
    memo: 'みりんを大さじ1増やすと好みの味。じゃがいもは男爵より メークイン の方が煮崩れしない。' },
  { title: '鶏むねのやわらか照り焼き', description: 'パサつかせないコツつき', servings: '2人分', prep_minutes: 20,
    tags: ['和食', '主菜', '時短'],
    ingredients: [
      { name: '鶏むね肉', amount: '1枚', group: '' },
      { name: '片栗粉', amount: '大さじ1', group: '' },
      { name: 'しょうゆ', amount: '大さじ2', group: 'タレ' },
      { name: 'みりん', amount: '大さじ2', group: 'タレ' },
      { name: '砂糖', amount: '小さじ2', group: 'タレ' },
    ],
    steps: ['鶏むね肉は皮を下にして、繊維を断つように1cm厚のそぎ切りにする。',
            '塩少々をふって10分置き、出た水気を拭いてから片栗粉を薄くまぶす。',
            'フライパンで中火、片面3分ずつ焼く。',
            'タレを加えて煮からめ、とろみがついたら火を止める。'],
    memo: '' },
  { title: '無限ピーマン', description: 'あと一品に', servings: '2人分', prep_minutes: 10,
    tags: ['副菜', '作り置き', '時短'],
    ingredients: [
      { name: 'ピーマン', amount: '4個', group: '' },
      { name: 'ツナ缶', amount: '1缶', group: '' },
      { name: 'ごま油', amount: '小さじ2', group: '' },
      { name: '鶏がらスープの素', amount: '小さじ1', group: '' },
    ],
    steps: ['ピーマンは細切りにする。', '耐熱ボウルに全部入れて混ぜ、ラップをしてレンジ600Wで3分。', '混ぜて粗熱を取る。'],
    memo: '' },
];

$('#cfg-demo').onclick = () => {
  localMode = true; save(LS.local, true);
  save(LS.name, 'わたし');
  save(LS.members, [{ id: ME_LOCAL, name: 'わたし', color: COLORS[0] }]);
  members = load(LS.members, []);
  if (!recipes.length) {
    recipes = SAMPLES.map((x) => ({
      id: uuid(), created_at: new Date().toISOString(),
      image_url: null, source_type: 'manual', source_url: null,
      favorite: false, cook_count: 0, last_cooked_on: null, created_by: ME_LOCAL, ...x,
    }));
    save(LS.cache, recipes);
  }
  applyMode();
  show('v-list'); renderList();
  toast('おためしモードで開きました');
};

// おためし中かどうかで画面の出し分け
function applyMode() {
  $('#localbar').classList.toggle('hidden', !localMode);
  $('#url-local').classList.toggle('hidden', !localMode);
  $('#fetch-url').disabled = localMode;
  $('#in-url').disabled = localMode;
  $('#s-logout').classList.toggle('hidden', localMode);
  $('#s-tosupa').classList.toggle('hidden', !localMode);
  $('#s-tosupa-note').classList.toggle('hidden', !localMode);
}

$('#lb-setup').onclick = () => $('#s-tosupa').click();
$('#s-tosupa').onclick = () => {
  if (!confirm('共有モードの設定に進みます。おためしで登録したレシピはこの端末に残りますが、共有側には自動で移りません。よろしいですか？')) return;
  localMode = false; save(LS.local, false);
  applyMode();
  $('#cfg-url').value = cfg?.url || ''; $('#cfg-key').value = cfg?.key || '';
  show('v-setup');
};

// --- ログイン
$('#li-go').onclick = async (e) => {
  const btn = e.currentTarget;
  showErr('#login-err', '');
  busy(btn, true, 'ログイン中');
  try {
    const rawMail = $('#li-mail').value, rawPass = $('#li-pass').value;
    const mail = toHalf(rawMail).trim(), pass = toHalf(rawPass).trim();
    if (mail !== rawMail.trim() || pass !== rawPass.trim()) {
      toast('全角の文字が含まれていたので半角に直しました');
      $('#li-mail').value = mail;
    }
    if (!pass) { showErr('#login-err', 'パスワードが空です'); return; }
    await login(mail, pass);
    $('#li-pass').value = '';
    applyMode();
    show('v-list'); renderList(); await sync();
  } catch (err) { showErr('#login-err', err.message); }
  finally { busy(btn, false, 'ログイン'); }
};
$('#li-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#li-go').click(); });

// パスワードの中身を確認できるようにする。
// iOS の自動入力が古いパスワードを入れていても気づけるように。
$('#li-eye').onclick = () => {
  const f = $('#li-pass');
  const show = f.type === 'password';
  f.type = show ? 'text' : 'password';
  $('#li-eye').textContent = show ? '隠す' : '表示';
};
$('#li-pass').addEventListener('input', (e) => {
  const n = e.target.value.length;
  $('#li-len').textContent = n ? `${n} 文字入力されています` : '';
});
$('#li-cfg').onclick = () => { $('#cfg-url').value = cfg?.url || ''; $('#cfg-key').value = cfg?.key || ''; show('v-setup'); };

// --- 一覧
$('#q').addEventListener('input', (e) => { filter.q = e.target.value; renderList(); });
$('#tagbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]'); if (!b) return;
  filter.tag = b.dataset.tag; renderList();
});
$('#list').addEventListener('click', (e) => {
  const c = e.target.closest('.rc'); if (!c) return;
  const r = recipes.find((x) => x.id === c.dataset.id);
  if (r) { renderDetail(r); }
});
$('#go-add').onclick = () => { current = null; openEditor(null); };
let myColor = COLORS[0];

function renderSwatches() {
  $('#s-colors').innerHTML = COLORS.map((c) =>
    `<button type="button" data-c="${c}" style="background:${c}" class="${c === myColor ? 'on' : ''}"></button>`).join('');
}
$('#s-colors').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]'); if (!b) return;
  myColor = b.dataset.c; renderSwatches();
});

$('#go-settings').onclick = () => {
  const me = memberOf(myId());
  $('#s-name').value = me?.name || load(LS.name, '') || '';
  myColor = COLORS.includes(me?.color) ? me.color : COLORS[0];
  renderSwatches();
  $('#s-who').textContent = localMode
    ? 'おためしモード（この端末にだけ保存）'
    : (session?.user?.email ? `ログイン中: ${session.user.email}` : '');
  $('#s-ver').textContent = `v${VERSION} ／ ${recipes.length} レシピ`;
  show('v-settings');
};

// --- 追加画面のタブ
$('#src-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-src]'); if (b) setTab(b.dataset.src);
});
$('#add-ing').onclick  = () => $('#ings').append(ingRow());
$('#add-step').onclick = () => { $('#steps').append(stepRow('', $$('#steps .lrow').length + 1)); renumber(); };
$('#ings').addEventListener('click', rowListClick);
$('#steps').addEventListener('click', rowListClick);

// --- URL から取り込み
$('#fetch-url').onclick = async (e) => {
  const btn = e.currentTarget;
  const url = $('#in-url').value.trim();
  if (!url) return;
  showErr('#ext-err', '');
  busy(btn, true, '読み込み中');
  try {
    const res = await extract({ mode: 'url', url });
    $('#form').dataset.sourceUrl = url;
    $('#form').dataset.sourceType = 'url';

    if (res.recipe) {                       // 構造化データ or AI で読めた
      fillForm(res.recipe);
      if (res.via === 'json-ld') toast('ページのレシピ情報から読み込みました');
      return;
    }
    // 構造化データが無いページ: 本文をこちらで解析する
    $('#in-paste').value = res.text.slice(0, 12000);
    const parsed = parseRecipeText(res.text);
    if (parsed) {
      if (res.page_title) parsed.title = res.page_title;
      if (res.image_url) parsed.image_url = res.image_url;
      fillForm(parsed);
      toast('本文から読み取りました。内容を確認してください');
    } else {
      setTab('paste');
      showErr('#ext-err', 'このページはレシピ情報を埋め込んでいませんでした。下の本文から材料と手順の部分だけ残して「この文章から読み込む」を押してください');
    }
  } catch (err) { showErr('#ext-err', err.message); }
  finally { busy(btn, false, 'このページから読み込む'); }
};

// --- 貼り付けた文章から取り込み（AI 不要・完全無料）
$('#parse-paste').onclick = () => {
  const text = $('#in-paste').value.trim();
  if (!text) return;
  showErr('#ext-err', '');
  const parsed = parseRecipeText(text);
  if (!parsed) {
    return showErr('#ext-err', 'レシピらしい記述が見つかりませんでした。「✏️ 手入力」で入力してください');
  }
  fillForm(parsed);
  if (!parsed.ingredients.length) toast('材料を読み取れませんでした。手順だけ入れています');
};

// --- レシピ写真を選ぶ
$('#f-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  $('#photo-drop').innerHTML = '<b><span class="spin"></span></b>アップロード中…';
  try {
    const url = await uploadImage(await shrink(file));
    $('#form').dataset.image = url;
    $('#photo-drop').innerHTML = `<img src="${cssUrl(url)}" style="max-height:150px;border-radius:10px">`;
  } catch (err) {
    $('#photo-drop').innerHTML = '<b>🖼</b>写真を選ぶ';
    toast(err.message);
  }
});

// --- 保存
$('#save').onclick = async (e) => {
  const btn = e.currentTarget;
  const row = readForm();
  if (!row.title) return toast('料理名を入れてください');
  busy(btn, true, '保存中');
  try {
    if (editing) {
      const saved = await rdb.update(editing.id, row);
      recipes = recipes.map((r) => (r.id === saved.id ? saved : r));
      current = saved;
      save(LS.cache, recipes);
      renderList(); renderDetail(saved);
    } else {
      const saved = await rdb.insert({
        ...row,
        source_type: $('#form').dataset.sourceType || 'manual',
        source_url:  $('#form').dataset.sourceUrl || null,
        created_by:  myId(),
      });
      recipes.unshift(saved); save(LS.cache, recipes);
      delete $('#form').dataset.sourceUrl; delete $('#form').dataset.sourceType;
      renderList(); renderDetail(saved);
    }
    toast(lastQueued ? '端末に保存しました（通信が戻ったら自動で共有します）' : '保存しました', lastQueued ? 3500 : 2200);
  } catch (err) { toast(`保存できませんでした: ${err.message}`); }
  finally { busy(btn, false, '保存する'); }
};

// --- 詳細内の操作
$('#detail').addEventListener('click', async (e) => {
  const sc = e.target.closest('.scaler button');
  if (sc) { scale = Number(sc.dataset.f); return rerenderIngredients(); }

  const ing = e.target.closest('.ing');
  if (ing) {
    const all = load(LS.checks, {});
    const set = new Set(all[current.id] || []);
    const i = Number(ing.dataset.i);
    set.has(i) ? set.delete(i) : set.add(i);
    all[current.id] = [...set]; save(LS.checks, all);
    return rerenderIngredients();
  }

  if (e.target.closest('#d-edit')) return openEditor(current);

  if (e.target.closest('#d-cooked')) {
    const btn = e.target.closest('#d-cooked');
    busy(btn, true, '記録中');
    try {
      await rdb.cooked(current.id);
      if (!lastQueued) await sync();
      const r = recipes.find((x) => x.id === current.id);
      if (r) renderDetail(r);
      toast(lastQueued ? '作った記録を端末に残しました（あとで送信）' : '作った記録を残しました');
    } catch (err) { toast(err.message); }
    finally { busy(btn, false, '🍽 作った'); }
  }

  if (e.target.closest('#d-uncook')) {
    const btn = e.target.closest('#d-uncook');
    btn.textContent = '取り消しています…';
    const q = Q.get();
    const mine = q.filter((x) => x.type === 'cooked' && x.id === current.id).pop();
    if (!localMode && mine) {
      Q.drop(mine.qid);
      const left = q.filter((x) => x.type === 'cooked' && x.id === current.id && x !== mine).pop();
      recipes = recipes.map((r) => (r.id === current.id ? { ...r,
        cook_count: Math.max(0, (r.cook_count || 1) - 1),
        last_cooked_on: left ? left.cooked_on : r.last_cooked_on } : r));
      save(LS.cache, recipes); renderList();
      renderDetail(recipes.find((x) => x.id === current.id));
      return toast(`${mine.cooked_on} の記録（未送信）を取り消しました`);
    }
    try {
      const [log] = await db.lastLog(current.id);
      if (!log) { toast('取り消せる記録がありません'); return; }
      await db.uncook(log.id, current.id);
      await sync();
      const r = recipes.find((x) => x.id === current.id);
      if (r) renderDetail(r);
      toast(`${log.cooked_on} の記録を取り消しました`);
    } catch (err) { toast(err.message); btn.textContent = '直近の「作った」を取り消す'; }
    return;
  }

  if (e.target.closest('#d-del')) {
    if (!confirm(`「${current.title}」を削除します。よろしいですか？`)) return;
    try {
      await rdb.remove(current.id);
      recipes = recipes.filter((r) => r.id !== current.id);
      save(LS.cache, recipes);
      current = null; show('v-list'); renderList(); toast('削除しました');
    } catch (err) { toast(err.message); }
  }
});

$('#d-fav').onclick = async () => {
  if (!current) return;
  const fav = !current.favorite;
  $('#d-fav').textContent = fav ? '★' : '☆';
  try {
    const saved = await rdb.update(current.id, { favorite: fav });
    current = saved;
    recipes = recipes.map((r) => (r.id === saved.id ? saved : r));
    save(LS.cache, recipes); renderList();
  } catch (err) { toast(err.message); $('#d-fav').textContent = current.favorite ? '★' : '☆'; }
};

// --- 設定画面
$('#s-savename').onclick = async (e) => {
  const btn = e.currentTarget;
  const name = $('#s-name').value.trim();
  if (!name) return toast('表示名を入れてください');
  save(LS.name, name);
  busy(btn, true, '保存中');
  try {
    await db.member(name, myColor);
    members = await db.members(); save(LS.members, members);
    renderList();
    toast('保存しました');
  } catch (err) { toast(err.message); }
  finally { busy(btn, false, '表示名と色を保存'); }
};
$('#s-logout').onclick = () => logout();
$('#s-reload').onclick = async () => { await sync(); show('v-list'); toast('最新にしました'); };
$('#s-reset').onclick = () => {
  if (!confirm('この端末の接続設定とログイン情報を消します。よろしいですか？')) return;
  localStorage.clear(); location.reload();
};

/* ============================== 起動 ============================== */
(async function start() {
  applyMode();
  if (localMode) { show('v-list'); renderList(); return sync(); }
  if (!cfg?.url) return show('v-setup');
  if (!session?.access_token) return show('v-login');
  show('v-list'); renderList();            // まずキャッシュで即描画
  const ok = await refresh();
  if (ok === false) return show('v-login'); // セッション切れ
  if (ok === 'offline') return toast('オフライン表示中');
  await sync();
})();

// 通信が戻ったら送信待ちを送って最新にする
window.addEventListener('online', () => { if (!localMode && session?.access_token) sync(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
