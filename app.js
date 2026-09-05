/* ══════════════════════════════════════════════════════════
   إيلوريا ستوري v2 — نفس الواجهة، قاعدة بيانات حقيقية
   • المحتوى في Postgres (Supabase)، الأغلفة في Storage
   • الصلاحيات محفوظة في قاعدة البيانات نفسها (RLS)
   • لا كلمة سر ولا مفتاح كتابة داخل هذا الملف
   ══════════════════════════════════════════════════════════ */

/* ← إعدادات المشروع.
   هاتان القيمتان علنيتان بالتصميم: مفتاح anon لا يمنح أي صلاحية
   بذاته، سياسات RLS في قاعدة البيانات هي التي تقرر من يكتب. */
const SUPABASE_URL      = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "PASTE_YOUR_ANON_PUBLIC_KEY";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const LS_KEY = "eloria-cache";      // نسخة محلية للعرض الفوري فقط
let DB = { novels: [], quotes: [], about: "" };
let editing = { novelId: null, chapterId: null };
let loaded  = false;                // هل وصلت البيانات من الخادم؟
let isAdmin = false;

/* ---------- تحميل البيانات ---------- */
function cacheLocal(){
  try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch(e){}
}

async function loadData(){
  // 1) اعرضي النسخة المحفوظة فورًا حتى لا تكون الصفحة فارغة
  try { const c = JSON.parse(localStorage.getItem(LS_KEY)); if (c) DB = c; } catch(e){}

  // 2) ثم اجلبي الحقيقة من قاعدة البيانات
  try {
    const [nv, ch, qt, st] = await Promise.all([
      sb.from("novels").select("*").order("position"),
      sb.from("chapters").select("*").order("position"),
      sb.from("quotes").select("*").order("position"),
      sb.from("site").select("value").eq("key", "about").maybeSingle()
    ]);
    if (nv.error || ch.error) throw (nv.error || ch.error);

    DB = {
      novels: (nv.data || []).map(n => ({
        id: n.id, title: n.title, status: n.status || "",
        tags: n.tags || [], desc: n.description || "",
        cover: n.cover || "", characters: n.characters || [],
        chapters: (ch.data || [])
          .filter(c => c.novel_id === n.id)
          .map(c => ({ id: c.id, title: c.title, text: c.text || "" }))
      })),
      quotes: (qt.data || []).map(q => ({ id: q.id, text: q.text, source: q.source || "" })),
      about: (st.data && st.data.value && st.data.value.text) || ""
    };
    loaded = true;
    cacheLocal();
  } catch(e){
    console.error("load failed", e);
    toast && toast("تعذّر الاتصال بالخادم — تُعرض آخر نسخة محفوظة");
  }
}

/* ---------- الحفظ ---------- */
/* كل أزرار المحرر تنادي persist() كما كانت تمامًا.
   الفرق أن الحفظ الآن يذهب إلى قاعدة البيانات لا إلى ملف. */
function persist(){
  DB.updatedAt = Date.now();
  cacheLocal();
  scheduleSync();
}

let syncTimer = null, syncing = false, syncQueued = false;
function scheduleSync(){
  if (!isAdmin) return;
  clearTimeout(syncTimer);
  setSyncStatus("جارٍ الحفظ...", "rose");
  syncTimer = setTimeout(syncNow, 1200);   // نجمع التعديلات المتتابعة
}

/* يرفع أي صورة ما زالت base64 إلى Storage ويعيد رابطها */
async function uploadImage(dataUrl, path){
  const blob = await (await fetch(dataUrl)).blob();
  const { error } = await sb.storage.from("covers")
    .upload(path, blob, { upsert: true, contentType: "image/jpeg" });
  if (error) throw error;
  const { data } = sb.storage.from("covers").getPublicUrl(path);
  return data.publicUrl + "?v=" + Date.now();
}

/* يحذف من الخادم ما لم يعد موجودًا محليًا */
async function deleteMissing(table, keepIds){
  const { data, error } = await sb.from(table).select("id");
  if (error) return;
  const gone = (data || []).map(r => r.id).filter(id => keepIds.indexOf(id) < 0);
  if (gone.length) await sb.from(table).delete().in("id", gone);
}

async function syncNow(){
  if (!isAdmin) return;
  if (!loaded){ setSyncStatus("لم تصل البيانات بعد — أعيدي تحميل الصفحة", ""); return; }
  if (syncing){ syncQueued = true; return; }
  syncing = true;
  setSyncStatus("جارٍ الحفظ... 🕊", "rose");
  const now = new Date().toISOString();

  try {
    // 1) الصور: من base64 إلى ملفات حقيقية
    for (const n of DB.novels){
      if (n.cover && n.cover.indexOf("data:") === 0)
        n.cover = await uploadImage(n.cover, `novels/${n.id}.jpg`);
      const chars = n.characters || [];
      for (let i = 0; i < chars.length; i++){
        if (chars[i].img && chars[i].img.indexOf("data:") === 0)
          chars[i].img = await uploadImage(chars[i].img, `chars/${n.id}-${i}.jpg`);
      }
    }

    // 2) الروايات
    const novelRows = DB.novels.map((n, i) => ({
      id: n.id, title: n.title, status: n.status || "",
      tags: n.tags || [], description: n.desc || "", cover: n.cover || "",
      characters: n.characters || [], position: i, updated_at: now
    }));
    if (novelRows.length){
      const { error } = await sb.from("novels").upsert(novelRows);
      if (error) throw error;
    }

    // 3) الفصول
    const chapterRows = [];
    DB.novels.forEach(n => (n.chapters || []).forEach((c, i) => chapterRows.push({
      id: c.id, novel_id: n.id, title: c.title, text: c.text || "", position: i, updated_at: now
    })));
    if (chapterRows.length){
      const { error } = await sb.from("chapters").upsert(chapterRows);
      if (error) throw error;
    }

    // 4) الاقتباسات (لم تكن لها معرّفات في النسخة القديمة)
    DB.quotes.forEach(q => { if (!q.id) q.id = uid(); });
    if (DB.quotes.length){
      const { error } = await sb.from("quotes").upsert(
        DB.quotes.map((q, i) => ({ id: q.id, text: q.text, source: q.source || "", position: i }))
      );
      if (error) throw error;
    }

    // 5) نبذة الكاتبة
    await sb.from("site").upsert({ key: "about", value: { text: DB.about || "" } });

    // 6) حذف ما أزالته من الموقع
    await deleteMissing("novels",   DB.novels.map(n => n.id));
    await deleteMissing("chapters", chapterRows.map(c => c.id));
    await deleteMissing("quotes",   DB.quotes.map(q => q.id));

    cacheLocal();
    setSyncStatus("محفوظ ✓ ظاهر للزوار الآن", "lilac");
  } catch(e){
    console.error("sync failed", e);
    setSyncStatus("تعذّر الحفظ — سيُعاد مع التعديل التالي", "");
  }

  syncing = false;
  if (syncQueued){ syncQueued = false; syncNow(); }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const esc = s => (s||"").replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- التنقل ---------- */
const views = ["home","library","novel","reader","quotes","about"];
function route(){
  const h = location.hash.replace(/^#\/?/, "");
  const [page, a, b] = h.split("/");
  let v = "home";
  if (page === "library") { v="library"; renderLibrary(); }
  else if (page === "quotes") { v="quotes"; renderQuotes(); }
  else if (page === "about") { v="about"; renderAbout(); }
  else if (page === "novel" && a) { v="novel"; renderNovel(a); }
  else if (page === "read" && a && b) { v="reader"; renderReader(a, b); }
  else { renderHome(); }
  views.forEach(x => document.getElementById("view-"+x).classList.toggle("active", x===v));
  document.querySelectorAll("nav a").forEach(l => l.classList.toggle("active", l.dataset.route===v || (v==="novel"||v==="reader") && l.dataset.route==="library"));
  window.scrollTo({top:0});
  updateProgress();
}
window.addEventListener("hashchange", route);

/* ---------- بطاقة رواية ---------- */
function bookCard(n){
  const cover = n.cover
    ? `<img src="${n.cover}" alt="${esc(n.title)}">`
    : `<div class="ph">ELORIA<br><small style="font-size:.6em; letter-spacing:.3em">STORY</small></div>`;
  return `<div class="book-card" onclick="location.hash='#/novel/${n.id}'">
    <div class="cover">${cover}</div>
    <h3>${esc(n.title)}</h3>
    <div class="meta">${(n.tags||[]).slice(0,2).map(esc).join(" · ")}</div>
    <div class="st"><span class="tag ${n.status==='مكتملة'?'':'lilac'}">${esc(n.status||"مستمرة")}</span>
    <span class="tag rose">${(n.chapters||[]).length} فصل</span></div>
  </div>`;
}

/* ---------- الرئيسية ---------- */
function renderHome(){
  const g = document.getElementById("latestGrid");
  const latest = [...DB.novels].slice(-4).reverse();
  g.innerHTML = latest.length ? latest.map(bookCard).join("")
    : `<div class="empty" style="grid-column:1/-1">لا توجد روايات بعد — الرفّ بانتظار حكايتك الأولى 🕯</div>`;
}

/* ---------- المكتبة ---------- */
let activeTag = null;
function renderLibrary(){
  const tags = [...new Set(DB.novels.flatMap(n => n.tags||[]))];
  document.getElementById("tagFilter").innerHTML = tags.length
    ? [`<button class="tag ${!activeTag?'lilac':''}" onclick="filterTag(null)">الكل</button>`,
       ...tags.map(t => `<button class="tag ${activeTag===t?'lilac':''}" onclick="filterTag('${esc(t)}')">${esc(t)}</button>`)].join("")
    : "";
  const list = activeTag ? DB.novels.filter(n => (n.tags||[]).includes(activeTag)) : DB.novels;
  document.getElementById("libraryGrid").innerHTML = list.length ? list.map(bookCard).join("")
    : `<div class="empty" style="grid-column:1/-1">المكتبة فارغة حاليًا${document.body.classList.contains("author") ? " — اضغطي «رواية جديدة» لتبدئي ✒" : ""}</div>`;
}
function filterTag(t){ activeTag = t; renderLibrary(); }

/* ---------- صفحة الرواية ---------- */
function renderNovel(id){
  const n = DB.novels.find(x => x.id === id);
  const el = document.getElementById("view-novel");
  if (!n) { el.innerHTML = `<div class="empty">لم نعثر على هذه الرواية.</div>`; return; }
  const cover = n.cover ? `<img src="${n.cover}" alt="">` : `<div class="ph">ELORIA</div>`;
  el.innerHTML = `
  <div class="novel-hero">
    <div class="cover">${cover}</div>
    <div>
      <h1>${esc(n.title)}</h1>
      <div>${(n.tags||[]).map(t=>`<span class="tag lilac">${esc(t)}</span>`).join("")}
        <span class="tag">${esc(n.status||"مستمرة")}</span></div>
      <p class="desc">${esc(n.desc||"")}</p>
      <div class="stat-row">
        <div class="stat"><b>${(n.chapters||[]).length}</b>عدد الفصول</div>
        <div class="stat"><b>${esc(n.status||"مستمرة")}</b>حالة الرواية</div>
      </div>
      ${(n.chapters||[]).length ? `<a class="btn btn-primary" href="#/read/${n.id}/${n.chapters[0].id}">ابدأ القراءة</a>` : ""}
      <span class="author-only">
        <button class="btn btn-secondary btn-sm" onclick="openNovelDialog('${n.id}')">تعديل الرواية</button>
        <button class="btn btn-danger btn-sm" onclick="deleteNovel('${n.id}')">حذف</button>
      </span>
    </div>
  </div>

  <div class="section-title"><span class="orn">✦</span><h2>الفصول</h2><div class="line"></div>
    <button class="btn btn-primary btn-sm author-only" onclick="openChapterDialog('${n.id}')">＋ فصل جديد</button>
  </div>
  <div class="author-only">
    <div class="dropzone" id="bulkDrop">🪶 أفلتي عدة ملفات <b>‎.txt / ‎.md</b> هنا لإضافتها كفصول دفعة واحدة</div>
  </div>
  <div class="chapter-list">
    ${(n.chapters||[]).map((c,i)=>`
      <div class="chapter-item" onclick="location.hash='#/read/${n.id}/${c.id}'">
        <span class="num">${i+1}</span>
        <span class="grow">${esc(c.title)}</span>
        <span class="author-only">
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openChapterDialog('${n.id}','${c.id}')">تعديل</button>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteChapter('${n.id}','${c.id}')">حذف</button>
        </span>
      </div>`).join("") || `<div class="empty">لا فصول بعد — القصة على وشك أن تبدأ ✨</div>`}
  </div>

  <div class="section-title"><span class="orn">❀</span><h2>الشخصيات الرئيسية</h2><div class="line"></div>
    <button class="btn btn-primary btn-sm author-only" onclick="openCharDialog('${n.id}')">＋ شخصية</button>
  </div>
  <div class="char-grid">
    ${(n.characters||[]).map((c,i)=>`
      <div class="char-card">
        <div class="av">${c.img ? `<img src="${c.img}">` : "🌸"}</div>
        <b>${esc(c.name)}</b><small>${esc(c.role||"")}</small>
        <div class="author-only" style="margin-top:.4rem"><button class="btn btn-danger btn-sm" onclick="deleteCharacter('${n.id}',${i})">حذف</button></div>
      </div>`).join("") || `<div class="empty" style="grid-column:1/-1">لم تُضف شخصيات بعد</div>`}
  </div>`;

  setupBulkDrop(n.id);
}

/* ---------- القراءة ---------- */
function renderReader(nid, cid){
  const n = DB.novels.find(x => x.id === nid);
  const el = document.getElementById("view-reader");
  if (!n) { el.innerHTML = `<div class="empty">لم نعثر على الرواية.</div>`; return; }
  const i = (n.chapters||[]).findIndex(c => c.id === cid);
  const c = n.chapters[i];
  if (!c) { el.innerHTML = `<div class="empty">لم نعثر على هذا الفصل.</div>`; return; }
  const prev = n.chapters[i-1], next = n.chapters[i+1];
  el.innerHTML = `
  <div class="reader-wrap">
    <div class="reader-bar">
      <a class="btn btn-ghost btn-sm" href="#/novel/${n.id}">↪ صفحة الرواية</a>
      <span class="title">${esc(c.title)}</span>
      <div class="font-ctl">
        <button onclick="fontSize(-1)" title="تصغير الخط">A-</button>
        <button onclick="fontSize(1)" title="تكبير الخط">A+</button>
      </div>
    </div>
    <div class="paper"><div class="chapter-text">${esc(c.text)}</div></div>
    <div class="reader-nav">
      ${prev ? `<a class="btn btn-secondary" href="#/read/${n.id}/${prev.id}">→ الفصل السابق</a>` : "<span></span>"}
      ${next ? `<a class="btn btn-primary" href="#/read/${n.id}/${next.id}">الفصل التالي ←</a>` : `<a class="btn btn-ghost" href="#/novel/${n.id}">نهاية الفصول المتاحة ✨</a>`}
    </div>
  </div>`;
}
let readerSize = parseFloat(localStorage.getItem("eloria-font") || "1.08");
document.documentElement.style.setProperty("--reader-size", readerSize+"rem");
function fontSize(d){
  readerSize = Math.min(1.6, Math.max(.85, readerSize + d*0.07));
  document.documentElement.style.setProperty("--reader-size", readerSize+"rem");
  localStorage.setItem("eloria-font", readerSize);
}
function updateProgress(){
  const fill = document.getElementById("progressFill");
  const onReader = document.getElementById("view-reader").classList.contains("active");
  if(!onReader){ fill.style.width="0"; return; }
  const max = document.documentElement.scrollHeight - innerHeight;
  fill.style.width = (max>0 ? (scrollY/max)*100 : 0) + "%";
}
addEventListener("scroll", updateProgress, {passive:true});

/* ---------- الاقتباسات ---------- */
function renderQuotes(){
  document.getElementById("quoteGrid").innerHTML = DB.quotes.length
    ? DB.quotes.map((q,i)=>`
      <div class="quote-card">
        <p>${esc(q.text)}</p>
        <small>— ${esc(q.source||"إيلوريا ستوري")}</small>
        <div class="author-only" style="margin-top:.5rem"><button class="btn btn-danger btn-sm" onclick="deleteQuote(${i})">حذف</button></div>
      </div>`).join("")
    : `<div class="empty" style="grid-column:1/-1">لا اقتباسات بعد</div>`;
}

/* ---------- عن الكاتبة ---------- */
function renderAbout(){
  document.getElementById("aboutText").textContent = DB.about || "اكتبي هنا نبذة عنك وعن عوالمك...";
}
function editAbout(){
  const t = prompt("نبذة عن الكاتبة:", DB.about || "");
  if (t !== null) { DB.about = t; persist(); renderAbout(); toast("تم حفظ النبذة"); }
}

/* ══════════════ وضع المؤلفة — دخول حقيقي ══════════════
   لا كلمة سر في الكود. الحساب في Supabase Auth، والصلاحية
   تُقرأ من جدول admins، وقاعدة البيانات هي التي تفرضها.      */

document.getElementById("authorKey").onclick = async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session){
    await sb.auth.signOut();
    isAdmin = false;
    document.body.classList.remove("author");
    const bar = document.getElementById("authorBar"); if (bar) bar.remove();
    toast("تم تسجيل الخروج");
    route();
  } else {
    lgEmail.value = ""; lgPass.value = "";
    loginDialog.showModal();
  }
};

async function doLogin(){
  const email = lgEmail.value.trim(), pass = lgPass.value;
  if (!email || !pass) return toast("أدخلي البريد وكلمة السر");
  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  btn.disabled = false;
  if (error) return toast("البريد أو كلمة السر غير صحيحة");
  loginDialog.close();
  await refreshAuth();
  route();
  if (isAdmin) toast("أهلًا بعودتك ✒ — وضع المؤلفة مفعّل");
}

async function resetPassword(){
  const email = lgEmail.value.trim();
  if (!email) return toast("اكتبي بريدك أولًا ثم اضغطي «نسيت كلمة السر»");
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href });
  toast(error ? "تعذّر الإرسال — تأكدي من البريد" : "أرسلنا رابط إعادة التعيين إلى بريدك ✉");
}

async function refreshAuth(){
  const { data: { session } } = await sb.auth.getSession();
  isAdmin = false;
  if (session){
    const { data } = await sb.from("admins")
      .select("user_id").eq("user_id", session.user.id).maybeSingle();
    isAdmin = !!data;
    if (!isAdmin) toast("هذا الحساب لا يملك صلاحية التعديل");
  }
  document.body.classList.toggle("author", isAdmin);
  if (isAdmin) addAuthorToolbar();
  else { const bar = document.getElementById("authorBar"); if (bar) bar.remove(); }
}

/* شريط أدوات المؤلفة */
function addAuthorToolbar(){
  if (document.getElementById("authorBar")) return;
  const bar = document.createElement("div");
  bar.id = "authorBar";
  bar.className = "author-only";
  bar.style.cssText = "max-width:1180px;margin:1rem auto 0;padding:0 1.2rem";
  bar.innerHTML = `<div class="panel" style="margin:0; display:flex; gap:.7rem; flex-wrap:wrap; align-items:center">
    <b style="color:var(--plum)">✒ الحفظ:</b>
    <span id="pubStatus" class="tag lilac">متصل ✓ كل تعديل يُحفظ تلقائيًا</span>
    <button class="btn btn-primary btn-sm" onclick="openNotifyDialog()">📢 إشعار القرّاء</button>
    <button class="btn btn-ghost btn-sm" onclick="openSubscribers()">👥 القرّاء</button>
    <button class="btn btn-ghost btn-sm" onclick="exportData()">⬇ نسخة احتياطية</button>
    <label class="btn btn-ghost btn-sm" style="cursor:pointer">⬆ استيراد<input type="file" accept=".json" hidden onchange="importData(this)"></label>
  </div>`;
  document.querySelector("header").after(bar);
}

function setSyncStatus(txt, cls){
  const el = document.getElementById("pubStatus");
  if (!el) return;
  el.textContent = txt || "متصل ✓ كل تعديل يُحفظ تلقائيًا";
  el.className = "tag " + (cls === undefined ? "lilac" : (cls || ""));
}

/* ---------- قائمة القرّاء ---------- */
async function openSubscribers(){
  const { data, error } = await sb.from("subscribers")
    .select("*").order("created_at", { ascending: false });
  if (error) return toast("تعذّر جلب القائمة");
  document.getElementById("subsList").innerHTML = (data || []).length
    ? data.map(s => `
      <div class="notify-item">
        <span class="grow">${esc(s.email)}${s.name ? " — " + esc(s.name) : ""}</span>
        <span class="tag ${s.status === "active" ? "lilac" : ""}">${s.status === "active" ? "مفعّل" : "بانتظار الموافقة"}</span>
        ${s.status !== "active" ? `<button class="btn btn-secondary btn-sm" onclick="setSubStatus('${s.id}','active')">قبول</button>` : ""}
        <button class="btn btn-danger btn-sm" onclick="setSubStatus('${s.id}','delete')">حذف</button>
      </div>`).join("")
    : `<div class="empty">لا مشتركين بعد</div>`;
  subsDialog.showModal();
}

async function setSubStatus(id, status){
  if (status === "delete"){
    if (!confirm("حذف هذا المشترك؟")) return;
    await sb.from("subscribers").delete().eq("id", id);
  } else {
    await sb.from("subscribers").update({ status }).eq("id", id);
  }
  openSubscribers();
}

/* ---------- تسجيل الزوار ---------- */
async function subscribeVisitor(){
  const email = (document.getElementById("subEmail").value || "").trim().toLowerCase();
  const name  = (document.getElementById("subName")  || {}).value || "";
  const msg   = document.getElementById("subMsg");
  const show  = (t, ok) => { msg.hidden = false; msg.textContent = t; msg.className = "sub-msg " + (ok ? "ok" : "err"); };

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return show("تأكد من كتابة البريد بشكل صحيح.", false);
  document.getElementById("subBtn").disabled = true;

  const { error } = await sb.from("subscribers").insert({ email, name: name.trim() });
  document.getElementById("subBtn").disabled = false;

  // 23505 = البريد مسجّل مسبقًا. نعامله كنجاح حتى لا نكشف من في القائمة.
  if (error && error.code !== "23505") return show("تعذّر التسجيل الآن — جرّب بعد قليل.", false);
  document.querySelector(".subscribe-card .sub-row").hidden = true;
  show("تم ✓ سيصلك إشعار عند نشر كل جديد.", true);
}

function exportData(){
  const blob = new Blob([JSON.stringify(DB, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "data.json";
  a.click();
  toast("تم تنزيل نسخة احتياطية من كل المحتوى");
}
function importData(inp){
  const f = inp.files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = () => {
    try { DB = JSON.parse(r.result); persist(); route(); toast("تم الاستيراد بنجاح"); }
    catch(e){ toast("الملف غير صالح"); }
  };
  r.readAsText(f);
}

/* ---------- روايات: إضافة / تعديل / حذف ---------- */
function openNovelDialog(id){
  editing.novelId = id || null;
  document.getElementById("novelDlgTitle").textContent = id ? "تعديل الرواية" : "رواية جديدة";
  const n = id ? DB.novels.find(x=>x.id===id) : {};
  nvTitle.value = n.title||""; nvStatus.value = n.status||"مستمرة";
  nvTags.value = (n.tags||[]).join(", "); nvDesc.value = n.desc||""; nvCover.value = "";
  novelDialog.showModal();
}
function saveNovel(){
  if (!nvTitle.value.trim()) return toast("أدخلي عنوان الرواية");
  const done = cover => {
    if (editing.novelId){
      const n = DB.novels.find(x=>x.id===editing.novelId);
      Object.assign(n, {title:nvTitle.value.trim(), status:nvStatus.value,
        tags:nvTags.value.split(",").map(t=>t.trim()).filter(Boolean), desc:nvDesc.value});
      if (cover) n.cover = cover;
    } else {
      DB.novels.push({id:uid(), title:nvTitle.value.trim(), status:nvStatus.value,
        tags:nvTags.value.split(",").map(t=>t.trim()).filter(Boolean),
        desc:nvDesc.value, cover:cover||"", chapters:[], characters:[]});
    }
    persist(); novelDialog.close(); route(); toast("تم حفظ الرواية 🌸");
  };
  const f = nvCover.files[0];
  if (f) readImage(f, done); else done(null);
}
function deleteNovel(id){
  if (!confirm("حذف الرواية بكل فصولها؟ لا يمكن التراجع.")) return;
  DB.novels = DB.novels.filter(n=>n.id!==id);
  persist(); location.hash = "#/library"; toast("تم حذف الرواية");
}
/* ضغط الصور حتى لا تمتلئ الذاكرة */
function readImage(file, cb){
  const r = new FileReader();
  r.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 700, k = Math.min(1, max/Math.max(img.width,img.height));
      const cv = document.createElement("canvas");
      cv.width = img.width*k; cv.height = img.height*k;
      cv.getContext("2d").drawImage(img,0,0,cv.width,cv.height);
      cb(cv.toDataURL("image/jpeg",.82));
    };
    img.src = r.result;
  };
  r.readAsDataURL(file);
}

/* ---------- فصول ---------- */
function openChapterDialog(nid, cid){
  editing.novelId = nid; editing.chapterId = cid||null;
  document.getElementById("chDlgTitle").textContent = cid ? "تعديل الفصل" : "فصل جديد";
  const n = DB.novels.find(x=>x.id===nid);
  const c = cid ? n.chapters.find(x=>x.id===cid) : {};
  chTitle.value = c.title||""; chText.value = c.text||"";
  chapterDialog.showModal();
}
function saveChapter(){
  if (!chTitle.value.trim()) return toast("أدخلي عنوان الفصل");
  const n = DB.novels.find(x=>x.id===editing.novelId);
  if (editing.chapterId){
    const c = n.chapters.find(x=>x.id===editing.chapterId);
    c.title = chTitle.value.trim(); c.text = chText.value;
  } else {
    n.chapters.push({id:uid(), title:chTitle.value.trim(), text:chText.value});
  }
  persist(); chapterDialog.close(); route(); toast("تم حفظ الفصل ✨");
}
function deleteChapter(nid, cid){
  if (!confirm("حذف هذا الفصل؟")) return;
  const n = DB.novels.find(x=>x.id===nid);
  n.chapters = n.chapters.filter(c=>c.id!==cid);
  persist(); route(); toast("تم حذف الفصل");
}

/* سحب وإفلات داخل نافذة الفصل */
const chDrop = document.getElementById("chDrop");
chDrop.onclick = () => chFile.click();
chFile.onchange = () => chFile.files[0] && readTextFile(chFile.files[0], (name, text) => {
  if (!chTitle.value) chTitle.value = name;
  chText.value = text;
});
["dragover","dragleave","drop"].forEach(ev => chDrop.addEventListener(ev, e => {
  e.preventDefault();
  chDrop.classList.toggle("drag", ev==="dragover");
  if (ev==="drop" && e.dataTransfer.files[0])
    readTextFile(e.dataTransfer.files[0], (name,text)=>{ if(!chTitle.value) chTitle.value=name; chText.value=text; });
}));
function readTextFile(f, cb){
  const r = new FileReader();
  r.onload = () => cb(f.name.replace(/\.(txt|md)$/i,""), r.result);
  r.readAsText(f);
}

/* سحب وإفلات جماعي في صفحة الرواية */
function setupBulkDrop(nid){
  const z = document.getElementById("bulkDrop");
  if (!z) return;
  ["dragover","dragleave","drop"].forEach(ev => z.addEventListener(ev, e => {
    e.preventDefault();
    z.classList.toggle("drag", ev==="dragover");
    if (ev==="drop"){
      const files = [...e.dataTransfer.files].filter(f=>/\.(txt|md)$/i.test(f.name));
      if (!files.length) return toast("الملفات المقبولة: txt أو md");
      const n = DB.novels.find(x=>x.id===nid);
      let left = files.length;
      files.forEach(f => readTextFile(f, (name, text) => {
        n.chapters.push({id:uid(), title:name, text});
        if (--left === 0){ persist(); route(); toast(`أُضيف ${files.length} فصل ✨`); }
      }));
    }
  }));
}

/* ---------- شخصيات ---------- */
function openCharDialog(nid){
  editing.novelId = nid;
  crName.value=""; crRole.value=""; crImg.value="";
  charDialog.showModal();
}
function saveCharacter(){
  if (!crName.value.trim()) return toast("أدخلي اسم الشخصية");
  const n = DB.novels.find(x=>x.id===editing.novelId);
  const done = img => {
    (n.characters ||= []).push({name:crName.value.trim(), role:crRole.value.trim(), img:img||""});
    persist(); charDialog.close(); route(); toast("أُضيفت الشخصية 🌸");
  };
  const f = crImg.files[0];
  if (f) readImage(f, done); else done(null);
}
function deleteCharacter(nid, i){
  if (!confirm("حذف الشخصية؟")) return;
  DB.novels.find(x=>x.id===nid).characters.splice(i,1);
  persist(); route();
}

/* ---------- اقتباسات ---------- */
function openQuoteDialog(){ qText.value=""; qSource.value=""; quoteDialog.showModal(); }
function saveQuote(){
  if (!qText.value.trim()) return toast("أدخلي نص الاقتباس");
  DB.quotes.push({text:qText.value.trim(), source:qSource.value.trim()});
  persist(); quoteDialog.close(); renderQuotes(); toast("أُضيف الاقتباس ❝");
}
function deleteQuote(i){
  if (!confirm("حذف الاقتباس؟")) return;
  DB.quotes.splice(i,1); persist(); renderQuotes();
}

/* ---------- تنبيه ---------- */
let toastTimer;
function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove("show"), 2600);
}

/* ══════════════════════════════════════════════════════════
   📢 إشعار القرّاء
   يرسل مباشرة عبر Google Apps Script — بلا GitHub Actions،
   وبلا أي كلمة سر داخل الموقع. قائمة القرّاء محفوظة في
   الخادم نفسه (script.google.com) لا في المستودع العلني.
   ══════════════════════════════════════════════════════════ */

/* ← الصقي هنا رابط الـ /exec بعد نشر Apps Script */
const NOTIFY_ENDPOINT = "https://script.google.com/macros/s/AKfycbySTvDpXb9_bevZrrSksv7aSUX762slEmtjabf7l9vNEKeFUjSkVpsICOQFQH30OK_5/exec";

const ANN_KEY = "eloria-announced";
let notifyRows = [];

function announcedSet(){
  try { return new Set(JSON.parse(localStorage.getItem(ANN_KEY) || "[]")); }
  catch(e){ return new Set(); }
}
function markAnnounced(keys){
  const s = announcedSet();
  keys.forEach(k => s.add(k));
  localStorage.setItem(ANN_KEY, JSON.stringify([...s]));
}

function openNotifyDialog(){
  const ann = announcedSet();
  const rows = [];
  DB.novels.forEach(n => {
    rows.push({ key:"n:"+n.id, type:"novel", novelId:n.id,
                label:`رواية جديدة: ${n.title}`, isNew: !ann.has("n:"+n.id) });
    (n.chapters||[]).forEach(c => {
      const k = "c:"+n.id+":"+c.id;
      rows.push({ key:k, type:"chapter", novelId:n.id, chapterId:c.id,
                  label:`${n.title} — ${c.title}`, isNew: !ann.has(k) });
    });
  });
  rows.sort((a,b) => (b.isNew?1:0) - (a.isNew?1:0));
  notifyRows = rows.slice(0, 40);

  document.getElementById("notifyList").innerHTML = notifyRows.length
    ? notifyRows.map((r,i) => `
      <label class="notify-item">
        <input type="checkbox" data-i="${i}">
        <span class="grow">${esc(r.label)}</span>
        <span class="tag ${r.isNew ? "lilac" : ""}">${r.isNew ? "جديد" : "سبق إرساله"}</span>
      </label>`).join("")
    : `<div class="empty">لا يوجد محتوى بعد</div>`;
  document.getElementById("notifyNote").value = "";
  notifyDialog.showModal();
}

/* يبني محتوى الرسالة من العناصر المختارة */
function buildNotifyPayload(){
  const chosen = [...document.querySelectorAll("#notifyList input:checked")]
                   .map(b => notifyRows[+b.dataset.i]);
  if (!chosen.length) return null;

  const base = location.origin + location.pathname.replace(/index\.html$/, "");
  const items = [];
  let cover = "";

  chosen.forEach(r => {
    const n = DB.novels.find(x => x.id === r.novelId);
    if (!n) return;
    if (!cover && n.cover) cover = n.cover;
    if (r.type === "novel"){
      items.push({ sub:"رواية جديدة ✦", title:n.title,
                   excerpt:(n.desc||"").slice(0,220),
                   link:`${base}#/novel/${n.id}` });
    } else {
      const c = (n.chapters||[]).find(x => x.id === r.chapterId);
      if (!c) return;
      items.push({ sub:`تم نشر فصل جديد! · ${n.title}`, title:c.title,
                   excerpt:String(c.text||"").replace(/\s+/g," ").slice(0,220),
                   link:`${base}#/read/${n.id}/${c.id}` });
    }
  });
  if (!items.length) return null;

  const first = chosen[0];
  const fn = DB.novels.find(x => x.id === first.novelId);
  const subject = first.type === "novel"
    ? `رواية جديدة على إيلوريا ستوري ✦ ${fn ? fn.title : ""}`
    : (items.length === 1 ? `تم نشر فصل جديد! ✦ ${fn ? fn.title : ""}`
                          : "فصول جديدة على إيلوريا ستوري ✦");

  return { subject, items, cover, keys: chosen.map(r => r.key),
           note: document.getElementById("notifyNote").value.trim() };
}

/* إرسال بنموذج مخفي — يتجاوز قيود CORS في Apps Script تمامًا */
function postToNotifier(payload){
  return new Promise(resolve => {
    let frame = document.getElementById("notifyFrame");
    if (!frame){
      frame = document.createElement("iframe");
      frame.id = "notifyFrame"; frame.name = "notifyFrame"; frame.style.display = "none";
      document.body.appendChild(frame);
    }
    const form = document.createElement("form");
    form.method = "POST"; form.action = NOTIFY_ENDPOINT;
    form.target = "notifyFrame"; form.style.display = "none";
    const field = document.createElement("input");
    field.type = "hidden"; field.name = "payload"; field.value = JSON.stringify(payload);
    form.appendChild(field);
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => { form.remove(); resolve(); }, 1200);
  });
}

async function sendNotifyRequest(){
  const payload = buildNotifyPayload();
  if (!payload) return toast("اختاري ما تريدين الإخبار عنه أولًا");
  if (NOTIFY_ENDPOINT.indexOf("PASTE_YOUR_ID_HERE") > -1) return toast("لم يُربط خادم الإشعارات بعد");
  if (!confirm(`سيصل القرّاء إشعار عن ${payload.items.length} عنصر. هل نرسل؟`)) return;

  const btn = document.getElementById("notifySendBtn");
  btn.disabled = true;
  toast("جارٍ النشر أولًا حتى تعمل الروابط... 🕊");
  await syncNow();                     // نتأكد أن كل شيء محفوظ قبل الإرسال
  toast("جارٍ إرسال الرسائل... ✉");
  await postToNotifier(payload);
  markAnnounced(payload.keys);
  btn.disabled = false;
  notifyDialog.close();
  toast("أُرسل ✓ ستصلك نسخة على بريدك للتأكيد");
}

/* بديل سريع: مشاركة الخبر على واتساب */
function shareOnWhatsApp(){
  const payload = buildNotifyPayload();
  if (!payload) return toast("اختاري ما تريدين مشاركته أولًا");
  const lines = payload.items.map(it => `${it.sub}\n📖 ${it.title}\n${it.link}`);
  const text = (payload.note ? payload.note + "\n\n" : "") + lines.join("\n\n");
  markAnnounced(payload.keys);
  window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank");
}

/* ---------- انطلاق ---------- */
refreshAuth().then(loadData).then(route);
