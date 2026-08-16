(function(){
  const productConfig=globalThis.CHATVAULT_PRODUCT_CONFIG||{};
  const productName=productConfig.productName||"Claude Export";
  const platformId=(productConfig.supportedPlatforms||["claude"])[0]||"claude";
  const platformLabel=(productConfig.platformLabels||{})[platformId]||"Claude";
  const platformHost=(productConfig.allowedHosts||["claude.ai"])[0]||"claude.ai";
  if(typeof productConfig.applyThemeVars==="function")productConfig.applyThemeVars(document.documentElement);
  document.title=productName+" · Theme Preview";

  const I18N={
    en:{page_title:"Claude Export",page_subtitle:"Theme Preview",language_label:"Language",lang_system:"System",selector_title:"Select Theme (10)",current_prefix:"Current:",reset:"Reset",role_user:"You Asked",footer_branding:"Exported by Claude Export",platform:"Claude",
      themes:{default:{name:"Minimalist",en:"Default",badge:null},natural:{name:"Natural",en:"Natural",badge:null},editorial:{name:"Editorial",en:"Editorial",badge:"PRO"},terminal:{name:"Terminal",en:"Terminal",badge:"PRO"},newsprint:{name:"Newsprint",en:"Newsprint",badge:"PRO"},aurora:{name:"Aurora",en:"Aurora",badge:"PRO"},mckinsey:{name:"McKinsey",en:"McKinsey",badge:"PRO"},oxford:{name:"Oxford",en:"Oxford",badge:"PRO"},midnight:{name:"Midnight",en:"Midnight",badge:"PRO"},"midnight-rose":{name:"Midnight Rose",en:"Midnight Rose",badge:"NEW"}}},
    zh_CN:{page_title:"Claude Export",page_subtitle:"主题预览",language_label:"语言",lang_system:"跟随系统",selector_title:"选择主题 (10 种)",current_prefix:"当前:",reset:"重置",role_user:"你问",footer_branding:"由 Claude Export 导出",platform:"Claude",
      themes:{default:{name:"极简纯白",en:"Default",badge:null},natural:{name:"自然原生",en:"Natural",badge:null},editorial:{name:"学术社评",en:"Editorial",badge:"PRO"},terminal:{name:"赛博终端",en:"Terminal",badge:"PRO"},newsprint:{name:"复古印报",en:"Newsprint",badge:"PRO"},aurora:{name:"流光极光",en:"Aurora",badge:"PRO"},mckinsey:{name:"麦肯锡商务",en:"McKinsey",badge:"PRO"},oxford:{name:"学术深青",en:"Oxford",badge:"PRO"},midnight:{name:"暗黑深邃",en:"Midnight",badge:"PRO"},"midnight-rose":{name:"午夜玫瑰",en:"Midnight Rose",badge:"NEW"}}},
    ja:{page_title:"Claude Export",page_subtitle:"テーマプレビュー",language_label:"言語",lang_system:"システム",selector_title:"テーマを選択 (10)",current_prefix:"現在:",reset:"リセット",role_user:"あなたの質問",footer_branding:"Claude Export でエクスポート",platform:"Claude",
      themes:{default:{name:"ミニマル",en:"Default",badge:null},natural:{name:"ナチュラル",en:"Natural",badge:null},editorial:{name:"エディトリアル",en:"Editorial",badge:"PRO"},terminal:{name:"ターミナル",en:"Terminal",badge:"PRO"},newsprint:{name:"ニュースプリント",en:"Newsprint",badge:"PRO"},aurora:{name:"オーロラ",en:"Aurora",badge:"PRO"},mckinsey:{name:"マッキンゼー",en:"McKinsey",badge:"PRO"},oxford:{name:"オックスフォード",en:"Oxford",badge:"PRO"},midnight:{name:"ミッドナイト",en:"Midnight",badge:"PRO"},"midnight-rose":{name:"ミッドナイトローズ",en:"Midnight Rose",badge:"NEW"}}},
    ko:{page_title:"Claude Export",page_subtitle:"테마 미리보기",language_label:"언어",lang_system:"시스템",selector_title:"테마 선택 (10)",current_prefix:"현재:",reset:"재설정",role_user:"질문",footer_branding:"Claude Export로 내보냄",platform:"Claude",
      themes:{default:{name:"미니멀",en:"Default",badge:null},natural:{name:"내추럴",en:"Natural",badge:null},editorial:{name:"에디토리얼",en:"Editorial",badge:"PRO"},terminal:{name:"터미널",en:"Terminal",badge:"PRO"},newsprint:{name:"뉴스프린트",en:"Newsprint",badge:"PRO"},aurora:{name:"오로라",en:"Aurora",badge:"PRO"},mckinsey:{name:"맥킨지",en:"McKinsey",badge:"PRO"},oxford:{name:"옥스퍼드",en:"Oxford",badge:"PRO"},midnight:{name:"미드나잇",en:"Midnight",badge:"PRO"},"midnight-rose":{name:"미드나이트 로즈",en:"Midnight Rose",badge:"NEW"}}},
    de:{page_title:"Claude Export",page_subtitle:"Themen-Vorschau",language_label:"Sprache",lang_system:"System",selector_title:"Thema wählen (10)",current_prefix:"Aktuell:",reset:"Zurücksetzen",role_user:"Sie fragten",footer_branding:"Exportiert von Claude Export",platform:"Claude",
      themes:{default:{name:"Minimalistisch",en:"Default",badge:null},natural:{name:"Natürlich",en:"Natural",badge:null},editorial:{name:"Editorial",en:"Editorial",badge:"PRO"},terminal:{name:"Terminal",en:"Terminal",badge:"PRO"},newsprint:{name:"Zeitung",en:"Newsprint",badge:"PRO"},aurora:{name:"Aurora",en:"Aurora",badge:"PRO"},mckinsey:{name:"McKinsey",en:"McKinsey",badge:"PRO"},oxford:{name:"Oxford",en:"Oxford",badge:"PRO"},midnight:{name:"Mitternacht",en:"Midnight",badge:"PRO"},"midnight-rose":{name:"Mitternachtsrose",en:"Midnight Rose",badge:"NEW"}}},
    fr:{page_title:"Claude Export",page_subtitle:"Aperçu des thèmes",language_label:"Langue",lang_system:"Système",selector_title:"Choisir un thème (10)",current_prefix:"Actuel:",reset:"Réinitialiser",role_user:"Vous avez demandé",footer_branding:"Exporté par Claude Export",platform:"Claude",
      themes:{default:{name:"Minimaliste",en:"Default",badge:null},natural:{name:"Naturel",en:"Natural",badge:null},editorial:{name:"Éditorial",en:"Editorial",badge:"PRO"},terminal:{name:"Terminal",en:"Terminal",badge:"PRO"},newsprint:{name:"Journal",en:"Newsprint",badge:"PRO"},aurora:{name:"Aurore",en:"Aurora",badge:"PRO"},mckinsey:{name:"McKinsey",en:"McKinsey",badge:"PRO"},oxford:{name:"Oxford",en:"Oxford",badge:"PRO"},midnight:{name:"Minuit",en:"Midnight",badge:"PRO"},"midnight-rose":{name:"Rose de Minuit",en:"Midnight Rose",badge:"NEW"}}},
    es:{page_title:"Claude Export",page_subtitle:"Vista previa de temas",language_label:"Idioma",lang_system:"Sistema",selector_title:"Seleccionar tema (10)",current_prefix:"Actual:",reset:"Restablecer",role_user:"Preguntaste",footer_branding:"Exportado por Claude Export",platform:"Claude",
      themes:{default:{name:"Minimalista",en:"Default",badge:null},natural:{name:"Natural",en:"Natural",badge:null},editorial:{name:"Editorial",en:"Editorial",badge:"PRO"},terminal:{name:"Terminal",en:"Terminal",badge:"PRO"},newsprint:{name:"Periódico",en:"Newsprint",badge:"PRO"},aurora:{name:"Aurora",en:"Aurora",badge:"PRO"},mckinsey:{name:"McKinsey",en:"McKinsey",badge:"PRO"},oxford:{name:"Oxford",en:"Oxford",badge:"PRO"},midnight:{name:"Medianoche",en:"Midnight",badge:"PRO"},"midnight-rose":{name:"Rosa de Medianoche",en:"Midnight Rose",badge:"NEW"}}},
    pt_BR:{page_title:"Claude Export",page_subtitle:"Visualização de temas",language_label:"Idioma",lang_system:"Sistema",selector_title:"Selecionar tema (10)",current_prefix:"Atual:",reset:"Redefinir",role_user:"Você perguntou",footer_branding:"Exportado por Claude Export",platform:"Claude",
      themes:{default:{name:"Minimalista",en:"Default",badge:null},natural:{name:"Natural",en:"Natural",badge:null},editorial:{name:"Editorial",en:"Editorial",badge:"PRO"},terminal:{name:"Terminal",en:"Terminal",badge:"PRO"},newsprint:{name:"Jornal",en:"Newsprint",badge:"PRO"},aurora:{name:"Aurora",en:"Aurora",badge:"PRO"},mckinsey:{name:"McKinsey",en:"McKinsey",badge:"PRO"},oxford:{name:"Oxford",en:"Oxford",badge:"PRO"},midnight:{name:"Meia-noite",en:"Midnight",badge:"PRO"},"midnight-rose":{name:"Rosa da Meia-noite",en:"Midnight Rose",badge:"NEW"}}},
    zh_TW:{page_title:"Claude Export",page_subtitle:"主題預覽",language_label:"語言",lang_system:"跟隨系統",selector_title:"選擇主題 (10 種)",current_prefix:"當前:",reset:"重置",role_user:"你問",footer_branding:"由 Claude Export 匯出",platform:"Claude",
      themes:{default:{name:"極簡純白",en:"Default",badge:null},natural:{name:"自然原生",en:"Natural",badge:null},editorial:{name:"學術社評",en:"Editorial",badge:"PRO"},terminal:{name:"賽博終端",en:"Terminal",badge:"PRO"},newsprint:{name:"復古印報",en:"Newsprint",badge:"PRO"},aurora:{name:"流光極光",en:"Aurora",badge:"PRO"},mckinsey:{name:"麥肯錫商務",en:"McKinsey",badge:"PRO"},oxford:{name:"學術深青",en:"Oxford",badge:"PRO"},midnight:{name:"暗黑深邃",en:"Midnight",badge:"PRO"},"midnight-rose":{name:"午夜玫瑰",en:"Midnight Rose",badge:"NEW"}}}
  };

  Object.keys(I18N).forEach(lang=>{
    const dict=I18N[lang];
    dict.page_title=productName;
    dict.platform=platformLabel;
    dict.footer_branding=String(dict.footer_branding||"").replace(/Claude Export/g,productName);
  });

  const THEME_ORDER=["default","natural","editorial","terminal","newsprint","aurora","mckinsey","oxford","midnight","midnight-rose"];

  function buildContent(dict){
    const userLabel=dict.role_user;
    const aiLabel=dict.platform.toUpperCase();
    const footerText=dict.footer_branding;
    return `
      <h1 class="export-title">${productName} — Save ${platformLabel} Conversations as PDF, Image & More</h1>
      <div class="export-meta-card">${dict.platform} · 2026-08-04 09:24</div>

      <div class="export-messages">
        <div class="msg-row user">
          <div class="role-row"><span class="role-line"></span><span class="role-tag user">${userLabel}</span></div>
          <div class="msg-card user">
            <p>What does ${productName} do for ${platformLabel} conversations?</p>
          </div>
        </div>

        <div class="msg-row assistant">
          <div class="role-row"><span class="role-tag assistant">${aiLabel}</span><span class="role-line"></span></div>
          <div class="msg-card assistant">
            <p>${productName} is a Chrome extension that lets you <strong>export ${platformLabel} conversations</strong> into portable formats — including <strong>PDF</strong>, <strong>Image (PNG)</strong>, <strong>Markdown</strong>, <strong>HTML</strong>, and <strong>Plain Text</strong>.</p>
            <p>Key highlights:</p>
            <ul>
              <li><strong>One-click export</strong> of the current conversation with original styling preserved</li>
              <li><strong>10 premium themes</strong> — from Minimalist to Midnight Rose — for PDF and Image output</li>
              <li><strong>Full Markdown fidelity</strong>: headings, lists, tables, blockquotes, inline code, and links</li>
              <li><strong>Code block syntax highlighting</strong> with language labels</li>
              <li>Optional <strong>role labels</strong>, <strong>conversation title</strong>, and <strong>export timestamp</strong></li>
            </ul>
            <p>You can also <em>right-align user messages</em>, <em>hide role labels</em>, or export <em>AI replies only</em> for a cleaner read.</p>
          </div>
        </div>

        <div class="msg-row user">
          <div class="role-row"><span class="role-line"></span><span class="role-tag user">${userLabel}</span></div>
          <div class="msg-card user">
            <p>Can you show me an example of how code and Markdown look when exported?</p>
          </div>
        </div>

        <div class="msg-row assistant">
          <div class="role-row"><span class="role-tag assistant">${aiLabel}</span><span class="role-line"></span></div>
          <div class="msg-card assistant">
            <p>Sure! Here's a quick demo covering the most common Markdown elements.</p>
            <p><strong>Inline styles</strong> like <em>italic</em>, <strong>bold</strong>, <code class="inline">inline code</code>, and <a href="#">hyperlinks</a> are all preserved.</p>
            <h4>Code Block Example</h4>
            <div class="code-block">
              <div class="code-label">javascript</div>
              <pre><code><span class="tok-com">// Async fetch with error handling</span>
<span class="tok-kw">async function</span> <span class="tok-fn">loadConversation</span>(id) {
  <span class="tok-kw">try</span> {
    <span class="tok-kw">const</span> res = <span class="tok-kw">await</span> fetch(<span class="tok-str">\`/api/chat/\${id}\`</span>);
    <span class="tok-kw">if</span> (!res.ok) <span class="tok-kw">throw new</span> Error(<span class="tok-str">"Not found"</span>);
    <span class="tok-kw">return await</span> res.json();
  } <span class="tok-kw">catch</span> (err) {
    console.warn(<span class="tok-str">"Export failed:"</span>, err);
  }
}</code></pre>
            </div>
            <h4>Table</h4>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Format</th><th>Best For</th><th>Themes</th></tr></thead>
                <tbody>
                  <tr><td>PDF</td><td>Sharing, printing, archiving</td><td>All 10</td></tr>
                  <tr><td>Image</td><td>Social media, quick previews</td><td>All 10</td></tr>
                  <tr><td>Markdown</td><td>Notion, Obsidian, dev tools</td><td>—</td></tr>
                  <tr><td>HTML</td><td>Web embedding, full fidelity</td><td>—</td></tr>
                </tbody>
              </table>
            </div>
            <div class="quote-block"><strong>Tip:</strong> Use the theme selector on the left to see how each of the 10 themes changes the look of this same content in real time.</div>
          </div>
        </div>

        <div class="msg-row user">
          <div class="role-row"><span class="role-line"></span><span class="role-tag user">${userLabel}</span></div>
          <div class="msg-card user">
            <p>How do I get started?</p>
          </div>
        </div>

        <div class="msg-row assistant">
          <div class="role-row"><span class="role-tag assistant">${aiLabel}</span><span class="role-line"></span></div>
          <div class="msg-card assistant">
            <p>Just open any conversation on <strong>${platformHost}</strong>, click the ${productName} icon, pick a format and theme, then hit <strong>Export</strong>. That's it — your file downloads instantly.</p>
          </div>
        </div>
      </div>

      <div class="export-footer">${footerText}</div>
    `;
  }

  const langSelect=document.getElementById('langSelect');
  const themeList=document.getElementById('themeList');
  const exportPage=document.getElementById('exportPage');
  const exportInner=document.getElementById('exportInner');

  function normalizePreviewLanguage(value){
    const input=String(value||'en').replace(/-/g,'_');
    const exact=Object.keys(I18N).find(key=>key.toLowerCase()===input.toLowerCase());
    if(exact)return exact;
    const base=input.split('_')[0].toLowerCase();
    if(base==='zh')return /(?:tw|hk|hant)/i.test(input)?'zh_TW':'zh_CN';
    if(base==='pt')return'pt_BR';
    return Object.keys(I18N).find(key=>key.split('_')[0].toLowerCase()===base)||'en';
  }

  function getLang(){
    // 优先看下拉选择值（初始为 "system"），而非 document.documentElement.lang（HTML 写死 "en"）
    const selected=langSelect?langSelect.value:(document.documentElement.lang||'system');
    if(selected==='system')return normalizePreviewLanguage(navigator.language||'en');
    return normalizePreviewLanguage(selected);
  }

  function applyI18n(){
    const lang=getLang();
    const dict=I18N[lang]||I18N.en;
    document.documentElement.lang=lang;
    document.querySelectorAll('[data-i18n-preview]').forEach(el=>{
      const key=el.getAttribute('data-i18n-preview');
      if(dict[key])el.textContent=dict[key];
    });
    document.querySelectorAll('[data-i18n-preview-value]').forEach(el=>{
      const key=el.getAttribute('data-i18n-preview-value');
      if(dict[key])el.textContent=dict[key];
    });
    const items=themeList.querySelectorAll('.theme-item');
    items.forEach(item=>{
      const id=item.dataset.theme;
      const info=dict.themes[id];
      if(!info)return;
      const nameEl=item.querySelector('.name');
      const enEl=item.querySelector('.en');
      const badgeEl=item.querySelector('.badge');
      if(nameEl)nameEl.textContent=info.name;
      if(enEl)enEl.textContent=info.en;
      if(badgeEl){
        if(info.badge){badgeEl.textContent=info.badge;badgeEl.style.display='block';}
        else{badgeEl.style.display='none';}
      }
    });
    const activeId=document.querySelector('.theme-item.active')?.dataset.theme||'default';
    const activeInfo=dict.themes[activeId];
    if(activeInfo){
      const labelEl=document.querySelector('.preview-toolbar .label');
      labelEl.innerHTML=dict.current_prefix+' <strong>'+activeInfo.name+'</strong>';
    }
    exportInner.innerHTML=buildContent(dict);
  }

  function renderThemeList(){
    const lang=getLang();
    const dict=I18N[lang]||I18N.en;
    themeList.innerHTML=THEME_ORDER.map((id,i)=>{
      const info=dict.themes[id]||{};
      const badge=info.badge?`<span class="badge">${info.badge}</span>`:'';
      return `<div class="theme-item${i===0?' active':''}" data-theme="${id}">${badge}<div class="thumb tp-${id}"><span class="mini-u"></span><span class="mini-a"></span></div><div class="info"><div class="name">${info.name||id}</div><div class="en">${info.en||''}</div></div></div>`;
    }).join('');
    themeList.querySelectorAll('.theme-item').forEach(item=>{
      item.addEventListener('click',()=>switchTheme(item.dataset.theme));
    });
  }

  function switchTheme(id){
    exportPage.className='export-page theme-'+id;
    document.querySelectorAll('.theme-item').forEach(item=>{
      item.classList.toggle('active',item.dataset.theme===id);
    });
    // 仅更新工具栏 "Current: X" 标签，不重建整个预览 DOM（内容不变，仅 CSS class 变）
    const lang=getLang();
    const dict=I18N[lang]||I18N.en;
    const activeInfo=dict.themes[id];
    if(activeInfo){
      const labelEl=document.querySelector('.preview-toolbar .label');
      if(labelEl)labelEl.innerHTML=dict.current_prefix+' <strong>'+activeInfo.name+'</strong>';
    }
  }

  langSelect.addEventListener('change',e=>{
    document.documentElement.lang=e.target.value;
    applyI18n();
  });

  document.getElementById('resetBtn').addEventListener('click',()=>{
    langSelect.value='system';
    document.documentElement.lang='system';
    switchTheme('default');
    applyI18n();
  });

  document.addEventListener('keydown',e=>{
    // 不在 select/input/textarea 内时才响应数字快捷键，避免劫持下拉内的按键
    if(e.target.closest&&e.target.closest('select, input, textarea, [contenteditable]'))return;
    const idx=parseInt(e.key);
    if(idx>=1&&idx<=9&&THEME_ORDER[idx-1]){e.preventDefault();switchTheme(THEME_ORDER[idx-1]);}
    if(e.key==='0'&&THEME_ORDER[9]){e.preventDefault();switchTheme(THEME_ORDER[9]);}
  });

  renderThemeList();
  switchTheme('default');
})();
