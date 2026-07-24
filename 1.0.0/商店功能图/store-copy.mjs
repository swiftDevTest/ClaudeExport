export function makeStoreCopy(locale, platform) {
  const p = platform;
  const copy = {
    en: {
      slide1: { label: "Extension panel", title: ["Export chats", `from ${p}`], body: [`Save ${p} conversations locally.`, "PDF, Word, Markdown, Image, Text, JSON."], bullets: [`Built for ${p} web`, "Clear free quota", "Private local generation"] },
      slide2: { label: "Batch export", title: ["Package", "many chats"], body: ["Select multiple conversations.", "Export them in one clean format."], bullets: ["Up to 10 chats", "Switch formats fast", "Built for archives"], cardTitle: "Batch ready", cardBody: "Select chats, then export", cardStat: "PDF / Word / MD" },
      slide3: { label: "Export settings", title: ["Themes and", "fields"], body: ["Choose document themes and control title,", "time, platform, receipt, and watermark fields."], bullets: ["Professional export themes", "Document field controls", "Clear Pro feature labels"], cardTitle: "Theme presets", cardBody: "Reports, papers, terminal style", cardStat: "8 export themes" },
      slide4: { label: "Selected export", title: ["Keep only", "what matters"], body: ["Pick key messages on the page,", "or grab AI replies in one click."], bullets: ["Select specific messages", "Filter AI replies fast", "Change format before export"] },
      slide5: { label: "Local private export", title: ["Local files", "ready to share"], body: ["Chat content stays on your device.", "Files are ready to edit, share, and archive."], bullets: ["PDF / Word / PNG generated locally", "Redact sensitive info on device", "Receipts help verify exports"] },
      smallTitle: `${p} chats to files`, smallSub: "PDF, Word, Markdown, Image", promoTitle: `Export ${p} locally`, promoSub: "PDF, Word, Markdown, JSON. No upload.", batchLabel: "Batch export", batchSub: "Package multi-chat files", privateLabel: "Private by design", privateSub: "No upload for conversion", pipelineTitle: "Local export pipeline", pipelineSub: "Generated in your browser", noServerTitle: "No conversion server", noServerSub: "Files are generated locally", noUploadTitle: "No chat upload", noUploadSub: "local conversion only", selectionPill: "Selected 1", exportPill: "Export", localFilesLabel: "Local files", formattedLabel: "Formatted", editableLabel: "Editable", shareCardLabel: "Share card",
    },
    "zh-CN": {
      slide1: { label: "扩展面板", title: ["导出聊天", `来自 ${p}`], body: [`将 ${p} 对话保存到本地。`, "支持 PDF、Word、Markdown、图片、文本、JSON。"], bullets: [`专为 ${p} 网页版打造`, "免费额度清晰可见", "本地私密生成"] },
      slide2: { label: "批量导出", title: ["一次打包", "多个聊天"], body: ["选择多个对话，", "用统一格式一次导出。"], bullets: ["一次最多 10 个聊天", "快速切换导出格式", "适合整理与归档"], cardTitle: "批量导出就绪", cardBody: "选择聊天，然后导出", cardStat: "PDF / Word / MD" },
      slide3: { label: "导出设置", title: ["主题与", "字段"], body: ["选择文档主题并控制标题、", "时间、平台、凭证及水印字段。"], bullets: ["专业导出主题", "文档字段可控", "Pro 功能清晰标注"], cardTitle: "主题预设", cardBody: "报告、论文与终端风格", cardStat: "8 款导出主题" },
      slide4: { label: "选择消息导出", title: ["只保留", "重要内容"], body: ["选择页面中的关键消息，", "或一键仅选择 AI 回复。"], bullets: ["选择指定消息", "快速筛选 AI 回复", "导出前切换格式"] },
      slide5: { label: "本地私密导出", title: ["本地文件", "随时分享"], body: ["聊天内容始终留在设备上，", "文件可直接编辑、分享和归档。"], bullets: ["PDF / Word / PNG 本地生成", "敏感信息在设备上脱敏", "导出凭证便于核验"] },
      smallTitle: `${p} 聊天转文件`, smallSub: "PDF、Word、Markdown、图片", promoTitle: `本地导出 ${p}`, promoSub: "支持 PDF、Word、Markdown、JSON，无需上传。", batchLabel: "批量导出", batchSub: "一次打包多个聊天", privateLabel: "隐私优先设计", privateSub: "转换无需上传聊天", pipelineTitle: "本地导出流程", pipelineSub: "在浏览器中直接生成", noServerTitle: "无需转换服务器", noServerSub: "文件直接在本地生成", noUploadTitle: "聊天无需上传", noUploadSub: "仅在本地转换", selectionPill: "已选 1 条", exportPill: "导出", localFilesLabel: "本地文件", formattedLabel: "精美排版", editableLabel: "可编辑", shareCardLabel: "分享卡片",
    },
    "zh-TW": {
      slide1: { label: "擴充功能面板", title: ["匯出聊天", `來自 ${p}`], body: [`將 ${p} 對話儲存至本機。`, "支援 PDF、Word、Markdown、圖片、文字、JSON。"], bullets: [`專為 ${p} 網頁版打造`, "免費額度清楚可見", "本機私密產生"] },
      slide2: { label: "批次匯出", title: ["一次打包", "多個聊天"], body: ["選取多個對話，", "以相同格式一次匯出。"], bullets: ["一次最多 10 個聊天", "快速切換匯出格式", "適合整理與封存"], cardTitle: "批次匯出就緒", cardBody: "選取聊天，然後匯出", cardStat: "PDF / Word / MD" },
      slide3: { label: "匯出設定", title: ["主題與", "欄位"], body: ["選擇文件主題並控制標題、", "時間、平台、憑證及浮水印欄位。"], bullets: ["專業匯出主題", "文件欄位可控制", "Pro 功能清楚標示"], cardTitle: "主題預設", cardBody: "報告、論文與終端風格", cardStat: "8 款匯出主題" },
      slide4: { label: "選取訊息匯出", title: ["只保留", "重要內容"], body: ["選取頁面中的重要訊息，", "或一鍵只選 AI 回覆。"], bullets: ["選取指定訊息", "快速篩選 AI 回覆", "匯出前切換格式"] },
      slide5: { label: "本機私密匯出", title: ["本機檔案", "隨時分享"], body: ["聊天內容始終留在裝置上，", "檔案可直接編輯、分享和封存。"], bullets: ["PDF / Word / PNG 本機產生", "敏感資訊在裝置上遮蔽", "匯出憑證便於核驗"] },
      smallTitle: `${p} 聊天轉檔案`, smallSub: "PDF、Word、Markdown、圖片", promoTitle: `本機匯出 ${p}`, promoSub: "支援 PDF、Word、Markdown、JSON，無需上傳。", batchLabel: "批次匯出", batchSub: "一次打包多個聊天", privateLabel: "隱私優先設計", privateSub: "轉換無需上傳聊天", pipelineTitle: "本機匯出流程", pipelineSub: "在瀏覽器中直接產生", noServerTitle: "無需轉換伺服器", noServerSub: "檔案直接在本機產生", noUploadTitle: "聊天無需上傳", noUploadSub: "僅在本機轉換", selectionPill: "已選 1 則", exportPill: "匯出", localFilesLabel: "本機檔案", formattedLabel: "精美排版", editableLabel: "可編輯", shareCardLabel: "分享卡片",
    },
    de: {
      slide1: { label: "Erweiterung", title: ["Chats exportieren", `aus ${p}`], body: [`${p}-Chats lokal speichern.`, "PDF, Word, Markdown, Bild, Text, JSON."], bullets: [`Für ${p} im Web`, "Klares Gratis-Kontingent", "Private lokale Erstellung"] },
      slide2: { label: "Stapelexport", title: ["Viele Chats", "gebündelt"], body: ["Mehrere Unterhaltungen auswählen.", "Gemeinsam in einem Format exportieren."], bullets: ["Bis zu 10 Chats", "Format schnell wechseln", "Ideal fürs Archiv"], cardTitle: "Stapel ist bereit", cardBody: "Chats wählen und exportieren", cardStat: "PDF / Word / MD" },
      slide3: { label: "Exporteinstellungen", title: ["Designs und", "Felder"], body: ["Dokumentdesigns wählen und Titel,", "Zeit, Plattform, Beleg und Wasserzeichen steuern."], bullets: ["Professionelle Designs", "Dokumentfelder steuern", "Pro-Funktionen klar markiert"], cardTitle: "Designvorlagen", cardBody: "Bericht, Papier, Terminal", cardStat: "8 Exportdesigns" },
      slide4: { label: "Ausgewählter Export", title: ["Nur Wichtiges", "behalten"], body: ["Wichtige Nachrichten auswählen", "oder nur KI-Antworten übernehmen."], bullets: ["Nachrichten gezielt wählen", "KI-Antworten schnell filtern", "Format vor Export wechseln"] },
      slide5: { label: "Privater lokaler Export", title: ["Lokale Dateien", "zum Teilen"], body: ["Chat-Inhalte bleiben auf dem Gerät.", "Dateien bearbeiten, teilen und archivieren."], bullets: ["PDF / Word / PNG lokal erstellt", "Sensible Daten lokal schwärzen", "Exportbelege zur Prüfung"] },
      smallTitle: `${p}-Chats als Dateien`, smallSub: "PDF, Word, Markdown, Bild", promoTitle: `${p} lokal exportieren`, promoSub: "PDF, Word, Markdown, JSON. Kein Upload.", batchLabel: "Stapelexport", batchSub: "Mehrere Chats bündeln", privateLabel: "Privat entwickelt", privateSub: "Kein Upload zur Umwandlung", pipelineTitle: "Lokaler Exportprozess", pipelineSub: "Direkt im Browser erstellt", noServerTitle: "Kein Konvertierungsserver", noServerSub: "Dateien entstehen lokal", noUploadTitle: "Kein Chat-Upload", noUploadSub: "nur lokale Umwandlung", selectionPill: "1 ausgewählt", exportPill: "Export", localFilesLabel: "Lokale Dateien", formattedLabel: "Formatiert", editableLabel: "Bearbeitbar", shareCardLabel: "Teilbare Karte",
    },
    es: {
      slide1: { label: "Panel de extensión", title: ["Exporta chats", `de ${p}`], body: [`Guarda conversaciones de ${p} localmente.`, "PDF, Word, Markdown, imagen, texto y JSON."], bullets: [`Creado para ${p} web`, "Cuota gratis visible", "Generación local y privada"] },
      slide2: { label: "Exportación por lotes", title: ["Agrupa", "varios chats"], body: ["Selecciona varias conversaciones.", "Expórtalas juntas en un solo formato."], bullets: ["Hasta 10 chats", "Cambia de formato rápido", "Ideal para archivar"], cardTitle: "Lote preparado", cardBody: "Selecciona chats y exporta", cardStat: "PDF / Word / MD" },
      slide3: { label: "Ajustes de exportación", title: ["Temas y", "campos"], body: ["Elige temas y controla título, hora,", "plataforma, recibo y marca de agua."], bullets: ["Temas profesionales", "Campos configurables", "Funciones Pro claras"], cardTitle: "Temas predefinidos", cardBody: "Informe, papel y terminal", cardStat: "8 temas de exportación" },
      slide4: { label: "Exportación seleccionada", title: ["Conserva", "lo importante"], body: ["Elige mensajes clave de la página", "o selecciona respuestas de IA en un clic."], bullets: ["Elige mensajes concretos", "Filtra respuestas de IA", "Cambia el formato antes"] },
      slide5: { label: "Exportación local privada", title: ["Archivos locales", "para compartir"], body: ["El chat se queda en tu dispositivo.", "Edita, comparte y archiva los archivos."], bullets: ["PDF / Word / PNG locales", "Oculta datos en tu dispositivo", "Recibos para verificar"] },
      smallTitle: `Chats de ${p} a archivos`, smallSub: "PDF, Word, Markdown, imagen", promoTitle: `Exporta ${p} localmente`, promoSub: "PDF, Word, Markdown y JSON. Sin subir chats.", batchLabel: "Exportación por lotes", batchSub: "Agrupa varios chats", privateLabel: "Privado por diseño", privateSub: "Sin subir chats para convertir", pipelineTitle: "Exportación local", pipelineSub: "Generada en tu navegador", noServerTitle: "Sin servidor de conversión", noServerSub: "Archivos generados localmente", noUploadTitle: "Sin subir chats", noUploadSub: "solo conversión local", selectionPill: "1 seleccionado", exportPill: "Exportar", localFilesLabel: "Archivos locales", formattedLabel: "Con formato", editableLabel: "Editable", shareCardLabel: "Tarjeta para compartir",
    },
    fr: {
      slide1: { label: "Panneau de l’extension", title: ["Exportez vos chats", `depuis ${p}`], body: [`Enregistrez les échanges ${p} en local.`, "PDF, Word, Markdown, image, texte et JSON."], bullets: [`Conçu pour ${p} web`, "Quota gratuit visible", "Génération locale privée"] },
      slide2: { label: "Export par lot", title: ["Regroupez", "plusieurs chats"], body: ["Sélectionnez plusieurs conversations.", "Exportez-les ensemble dans un format."], bullets: ["Jusqu’à 10 chats", "Changez vite de format", "Idéal pour les archives"], cardTitle: "Lot prêt", cardBody: "Choisissez les chats puis exportez", cardStat: "PDF / Word / MD" },
      slide3: { label: "Réglages d’export", title: ["Thèmes et", "champs"], body: ["Choisissez les thèmes et contrôlez titre,", "heure, plateforme, reçu et filigrane."], bullets: ["Thèmes professionnels", "Champs configurables", "Fonctions Pro visibles"], cardTitle: "Thèmes prédéfinis", cardBody: "Rapport, papier, terminal", cardStat: "8 thèmes d’export" },
      slide4: { label: "Export sélectionné", title: ["Gardez", "l’essentiel"], body: ["Choisissez les messages importants", "ou les réponses IA en un clic."], bullets: ["Messages précis", "Filtre IA rapide", "Format modifiable avant"] },
      slide5: { label: "Export local privé", title: ["Fichiers locaux", "prêts à partager"], body: ["Le chat reste sur votre appareil.", "Modifiez, partagez et archivez vos fichiers."], bullets: ["PDF / Word / PNG générés en local", "Masquage local des données", "Reçus pour vérification"] },
      smallTitle: `Chats ${p} vers fichiers`, smallSub: "PDF, Word, Markdown, image", promoTitle: `Exportez ${p} en local`, promoSub: "PDF, Word, Markdown et JSON. Aucun envoi.", batchLabel: "Export par lot", batchSub: "Regroupez plusieurs chats", privateLabel: "Privé par conception", privateSub: "Aucun envoi pour convertir", pipelineTitle: "Export local", pipelineSub: "Généré dans votre navigateur", noServerTitle: "Sans serveur de conversion", noServerSub: "Fichiers générés en local", noUploadTitle: "Aucun chat envoyé", noUploadSub: "conversion locale uniquement", selectionPill: "1 sélectionné", exportPill: "Exporter", localFilesLabel: "Fichiers locaux", formattedLabel: "Mis en forme", editableLabel: "Modifiable", shareCardLabel: "Carte à partager",
    },
    ja: {
      slide1: { label: "拡張機能パネル", title: ["チャットを書き出す", `${p} から`], body: [`${p} の会話をローカル保存。`, "PDF、Word、Markdown、画像、テキスト、JSON。"], bullets: [`${p} Web版に最適化`, "無料枠を明確に表示", "非公開のローカル生成"] },
      slide2: { label: "一括書き出し", title: ["複数チャットを", "まとめて保存"], body: ["複数の会話を選択し、", "同じ形式でまとめて書き出せます。"], bullets: ["最大10件のチャット", "形式をすばやく切替", "アーカイブに最適"], cardTitle: "一括処理の準備完了", cardBody: "チャットを選んで書き出し", cardStat: "PDF / Word / MD" },
      slide3: { label: "書き出し設定", title: ["テーマと", "項目"], body: ["文書テーマを選び、タイトル、時刻、", "サービス、レシート、透かしを設定。"], bullets: ["プロ向け文書テーマ", "文書項目を設定", "Pro機能を明確に表示"], cardTitle: "テーマプリセット", cardBody: "レポート、論文、ターミナル", cardStat: "8種類のテーマ" },
      slide4: { label: "選択して書き出し", title: ["必要な内容だけ", "残せます"], body: ["ページ内の重要なメッセージや、", "AI回答だけをワンクリックで選択。"], bullets: ["メッセージを個別選択", "AI回答をすばやく抽出", "書き出し前に形式変更"] },
      slide5: { label: "非公開のローカル書き出し", title: ["ローカルファイルを", "すぐ共有"], body: ["チャット内容は端末内に保持。", "編集、共有、保存にすぐ使えます。"], bullets: ["PDF / Word / PNGをローカル生成", "機密情報を端末内で編集", "レシートで書き出しを確認"] },
      smallTitle: `${p} をファイルに保存`, smallSub: "PDF、Word、Markdown、画像", promoTitle: `${p} をローカル書き出し`, promoSub: "PDF、Word、Markdown、JSON。アップロード不要。", batchLabel: "一括書き出し", batchSub: "複数チャットをまとめて保存", privateLabel: "プライバシー設計", privateSub: "変換時のアップロード不要", pipelineTitle: "ローカル書き出し", pipelineSub: "ブラウザ内で直接生成", noServerTitle: "変換サーバー不要", noServerSub: "ファイルをローカル生成", noUploadTitle: "チャット送信なし", noUploadSub: "ローカル変換のみ", selectionPill: "1件選択", exportPill: "書き出し", localFilesLabel: "ローカルファイル", formattedLabel: "整形済み", editableLabel: "編集可能", shareCardLabel: "共有カード",
    },
    ko: {
      slide1: { label: "확장 프로그램 패널", title: ["채팅 내보내기", `${p}에서`], body: [`${p} 대화를 로컬에 저장하세요.`, "PDF, Word, Markdown, 이미지, 텍스트, JSON."], bullets: [`${p} 웹에 최적화`, "무료 할당량 명확히 표시", "비공개 로컬 생성"] },
      slide2: { label: "일괄 내보내기", title: ["여러 채팅을", "한 번에 저장"], body: ["여러 대화를 선택하고", "같은 형식으로 한 번에 내보내세요."], bullets: ["최대 10개 채팅", "형식 빠르게 전환", "보관에 최적화"], cardTitle: "일괄 작업 준비 완료", cardBody: "채팅 선택 후 내보내기", cardStat: "PDF / Word / MD" },
      slide3: { label: "내보내기 설정", title: ["테마와", "필드"], body: ["문서 테마를 선택하고 제목, 시간,", "플랫폼, 영수증, 워터마크를 설정하세요."], bullets: ["전문 내보내기 테마", "문서 필드 설정", "Pro 기능 명확히 표시"], cardTitle: "테마 프리셋", cardBody: "보고서, 논문, 터미널", cardStat: "8개 내보내기 테마" },
      slide4: { label: "선택 내보내기", title: ["중요한 내용만", "남기기"], body: ["페이지에서 핵심 메시지를 고르거나", "AI 답변만 한 번에 선택하세요."], bullets: ["특정 메시지 선택", "AI 답변 빠르게 필터링", "내보내기 전 형식 변경"] },
      slide5: { label: "비공개 로컬 내보내기", title: ["로컬 파일을", "바로 공유"], body: ["채팅 내용은 기기에만 남습니다.", "파일을 편집, 공유, 보관할 수 있어요."], bullets: ["PDF / Word / PNG 로컬 생성", "민감 정보 기기에서 편집", "영수증으로 내보내기 확인"] },
      smallTitle: `${p} 채팅을 파일로`, smallSub: "PDF, Word, Markdown, 이미지", promoTitle: `${p} 로컬 내보내기`, promoSub: "PDF, Word, Markdown, JSON. 업로드 불필요.", batchLabel: "일괄 내보내기", batchSub: "여러 채팅을 한 번에 저장", privateLabel: "개인정보 보호 설계", privateSub: "변환을 위한 업로드 없음", pipelineTitle: "로컬 내보내기", pipelineSub: "브라우저에서 직접 생성", noServerTitle: "변환 서버 없음", noServerSub: "파일을 로컬에서 생성", noUploadTitle: "채팅 업로드 없음", noUploadSub: "로컬 변환만 사용", selectionPill: "1개 선택", exportPill: "내보내기", localFilesLabel: "로컬 파일", formattedLabel: "서식 적용", editableLabel: "편집 가능", shareCardLabel: "공유 카드",
    },
    "pt-BR": {
      slide1: { label: "Painel da extensão", title: ["Exporte chats", `do ${p}`], body: [`Salve conversas do ${p} localmente.`, "PDF, Word, Markdown, imagem, texto e JSON."], bullets: [`Feito para ${p} web`, "Cota grátis visível", "Geração local e privada"] },
      slide2: { label: "Exportação em lote", title: ["Agrupe", "vários chats"], body: ["Selecione várias conversas.", "Exporte todas juntas em um formato."], bullets: ["Até 10 chats", "Troque de formato rápido", "Ideal para arquivar"], cardTitle: "Lote pronto", cardBody: "Selecione chats e exporte", cardStat: "PDF / Word / MD" },
      slide3: { label: "Configurações de exportação", title: ["Temas e", "campos"], body: ["Escolha temas e controle título, hora,", "plataforma, recibo e marca-d’água."], bullets: ["Temas profissionais", "Campos configuráveis", "Recursos Pro bem indicados"], cardTitle: "Temas predefinidos", cardBody: "Relatório, papel e terminal", cardStat: "8 temas de exportação" },
      slide4: { label: "Exportação selecionada", title: ["Mantenha só", "o importante"], body: ["Escolha mensagens importantes", "ou selecione respostas de IA em um clique."], bullets: ["Escolha mensagens específicas", "Filtre respostas da IA", "Mude o formato antes"] },
      slide5: { label: "Exportação local privada", title: ["Arquivos locais", "para compartilhar"], body: ["O chat permanece no seu dispositivo.", "Edite, compartilhe e arquive os arquivos."], bullets: ["PDF / Word / PNG gerados localmente", "Oculte dados no dispositivo", "Recibos para verificação"] },
      smallTitle: `Chats do ${p} em arquivos`, smallSub: "PDF, Word, Markdown, imagem", promoTitle: `Exporte o ${p} localmente`, promoSub: "PDF, Word, Markdown e JSON. Sem upload.", batchLabel: "Exportação em lote", batchSub: "Agrupe vários chats", privateLabel: "Privado por padrão", privateSub: "Sem upload para conversão", pipelineTitle: "Exportação local", pipelineSub: "Gerada no seu navegador", noServerTitle: "Sem servidor de conversão", noServerSub: "Arquivos gerados localmente", noUploadTitle: "Sem upload de chats", noUploadSub: "somente conversão local", selectionPill: "1 selecionado", exportPill: "Exportar", localFilesLabel: "Arquivos locais", formattedLabel: "Formatado", editableLabel: "Editável", shareCardLabel: "Cartão compartilhável",
    },
  };

  const syncOverrides = {
    en: {
      slide1: { label: "Sync & Export", title: ["1-Click Sync to", "Notion / Obsidian"], body: [`Save ${p} chats to your knowledge base,`, "or export polished local files instantly."], bullets: ["One-click sync to Notion / Obsidian", "PDF, Word, Markdown, HTML, Image & Text", `Built only for ${p}`] },
      slide2: { label: "Batch Export & Sync", title: ["Batch Export", "& Sync Chats"], body: [`Export multiple ${p} chats as files,`, "or sync them to Notion / Obsidian."], bullets: ["Batch export local files", "Batch sync to Notion / Obsidian", "Up to 10 conversations at once"], cardTitle: "Ready to process", cardBody: "Choose chats and a destination", cardStat: "Export or sync" },
      smallTitle: "1-Click Sync to", smallSub: "Notion / Obsidian / PDF / DOCX", promoTitle: `Sync ${p} chats in 1 click`, promoSub: "Save to Notion, Obsidian, or polished local files.", batchLabel: "Batch export & sync", batchSub: "Process multiple chats at once", privateLabel: "Private local files", privateSub: "Chat content stays in your browser", pipelineTitle: "Local & Direct Sync", pipelineSub: `${p} content stays in your browser`, noServerTitle: "No conversion server", noServerSub: "Direct sync & local files", noUploadTitle: "Private sync", noUploadSub: "Browser-side execution", notionBody: "Database", obsidianBody: "Local vault", localFilesBody: "Local files",
    },
    "zh-CN": {
      slide1: { label: "同步与导出", title: ["一键同步至", "Notion / Obsidian"], body: [`将 ${p} 对话同步至知识库，`, "也可立即导出精美本地文件。"], bullets: ["一键同步 Notion / Obsidian", "支持 PDF、Word、Markdown、HTML、图片与文本", `仅适用于 ${p}`] },
      slide2: { label: "批量导出与同步", title: ["批量导出", "与同步对话"], body: [`将多个 ${p} 对话批量导出为文件，`, "或一次同步至 Notion / Obsidian。"], bullets: ["批量导出本地文件", "批量同步 Notion / Obsidian", "一次最多处理 10 个对话"], cardTitle: "准备批量处理", cardBody: "选择对话与目标位置", cardStat: "导出或同步" },
      smallTitle: "一键同步至", smallSub: "Notion / Obsidian / PDF / Word", promoTitle: `一键同步 ${p} 对话`, promoSub: "保存至 Notion、Obsidian，或导出精美本地文件。", batchLabel: "批量导出与同步", batchSub: "一次处理多个对话", privateLabel: "私密本地文件", privateSub: "聊天内容始终留在浏览器中", pipelineTitle: "本地与直连同步", pipelineSub: `${p} 内容始终留在浏览器中`, noServerTitle: "无需转换服务器", noServerSub: "直连同步与本地文件", noUploadTitle: "私密同步", noUploadSub: "浏览器端本地执行", notionBody: "数据库", obsidianBody: "本地知识库", localFilesBody: "本地文件",
    },
    "zh-TW": {
      slide1: { label: "同步與匯出", title: ["一鍵同步至", "Notion / Obsidian"], body: [`將 ${p} 對話同步至知識庫，`, "也可立即匯出精美本機檔案。"], bullets: ["一鍵同步 Notion / Obsidian", "支援 PDF、Word、Markdown、HTML、圖片與文字", `僅適用於 ${p}`] },
      slide2: { label: "批次匯出與同步", title: ["批次匯出", "與同步對話"], body: [`將多個 ${p} 對話批次匯出為檔案，`, "或一次同步至 Notion / Obsidian。"], bullets: ["批次匯出本機檔案", "批次同步 Notion / Obsidian", "一次最多處理 10 個對話"], cardTitle: "準備批次處理", cardBody: "選取對話與目的地", cardStat: "匯出或同步" },
      smallTitle: "一鍵同步至", smallSub: "Notion / Obsidian / PDF / Word", promoTitle: `一鍵同步 ${p} 對話`, promoSub: "儲存至 Notion、Obsidian，或匯出精美本機檔案。", batchLabel: "批次匯出與同步", batchSub: "一次處理多個對話", privateLabel: "私密本機檔案", privateSub: "聊天內容始終留在瀏覽器中", pipelineTitle: "本機與直連同步", pipelineSub: `${p} 內容始終留在瀏覽器中`, noServerTitle: "無需轉換伺服器", noServerSub: "直連同步與本機檔案", noUploadTitle: "私密同步", noUploadSub: "瀏覽器端執行", notionBody: "資料庫", obsidianBody: "本機知識庫", localFilesBody: "本機檔案",
    },
    de: {
      slide1: { label: "Sync & Export", title: ["1-Klick-Sync zu", "Notion / Obsidian"], body: [`${p}-Chats mit Ihrer Wissensbasis verbinden`, "oder sofort als lokale Dateien exportieren."], bullets: ["Notion / Obsidian mit 1 Klick", "PDF, Word, Markdown, HTML, Bild & Text", `Nur für ${p}`] },
      slide2: { label: "Stapelexport & Sync", title: ["Chats stapelweise", "exportieren / syncen"], body: [`Mehrere ${p}-Chats als Dateien exportieren`, "oder zu Notion / Obsidian synchronisieren."], bullets: ["Dateien stapelweise exportieren", "Notion / Obsidian stapelweise syncen", "Bis zu 10 Chats gleichzeitig"], cardTitle: "Bereit zur Verarbeitung", cardBody: "Chats und Ziel auswählen", cardStat: "Export oder Sync" },
      smallTitle: "1-Klick-Sync zu", smallSub: "Notion / Obsidian / PDF / Word", promoTitle: `${p}-Chats mit 1 Klick syncen`, promoSub: "Mit Notion / Obsidian synchronisieren oder lokal exportieren.", batchLabel: "Stapelexport & Sync", batchSub: "Mehrere Chats verarbeiten", privateLabel: "Private lokale Dateien", privateSub: "Chat-Inhalte bleiben im Browser", pipelineTitle: "Lokaler & direkter Sync", pipelineSub: `${p}-Inhalte bleiben im Browser`, noServerTitle: "Kein Konvertierungsserver", noServerSub: "Direkter Sync & lokale Dateien", noUploadTitle: "Privater Sync", noUploadSub: "Ausführung im Browser", notionBody: "Datenbank", obsidianBody: "Lokaler Vault", localFilesBody: "Lokale Dateien",
    },
    es: {
      slide1: { label: "Sincroniza y exporta", title: ["Sincroniza en 1 clic", "Notion / Obsidian"], body: [`Guarda chats de ${p} en tu base de conocimiento`, "o expórtalos como archivos al instante."], bullets: ["Notion / Obsidian en 1 clic", "PDF, Word, Markdown, HTML, imagen y texto", `Solo para ${p}`] },
      slide2: { label: "Exporta y sincroniza en lote", title: ["Exporta y sincroniza", "varios chats"], body: [`Exporta varios chats de ${p} como archivos`, "o sincronízalos con Notion / Obsidian."], bullets: ["Exportación de archivos por lotes", "Notion / Obsidian por lotes", "Hasta 10 conversaciones a la vez"], cardTitle: "Listo para procesar", cardBody: "Elige chats y destino", cardStat: "Exporta o sincroniza" },
      smallTitle: "Sincroniza en 1 clic", smallSub: "Notion / Obsidian / PDF / Word", promoTitle: `Sincroniza ${p} en 1 clic`, promoSub: "Guarda en Notion, Obsidian o archivos locales.", batchLabel: "Exporta y sincroniza", batchSub: "Procesa varios chats", privateLabel: "Archivos locales privados", privateSub: "El chat permanece en tu navegador", pipelineTitle: "Proceso local y sync directo", pipelineSub: `${p} permanece en tu navegador`, noServerTitle: "Sin servidor de conversión", noServerSub: "Sync directo y archivos locales", noUploadTitle: "Sincronización privada", noUploadSub: "ejecución en el navegador", notionBody: "Base de datos", obsidianBody: "Bóveda local", localFilesBody: "Archivos locales",
    },
    fr: {
      slide1: { label: "Synchronisez et exportez", title: ["Synchro en 1 clic", "Notion / Obsidian"], body: [`Enregistrez vos chats ${p} dans votre base`, "ou exportez immédiatement des fichiers soignés."], bullets: ["Notion / Obsidian en 1 clic", "PDF, Word, Markdown, HTML, image et texte", `Uniquement pour ${p}`] },
      slide2: { label: "Export et synchro par lot", title: ["Exportez et synchronisez", "plusieurs chats"], body: [`Exportez plusieurs chats ${p} en fichiers`, "ou synchronisez-les vers Notion / Obsidian."], bullets: ["Export de fichiers par lot", "Synchro par lot vers Notion / Obsidian", "Jusqu’à 10 conversations à la fois"], cardTitle: "Prêt à traiter", cardBody: "Choisissez chats et destination", cardStat: "Export ou synchro" },
      smallTitle: "Synchro en 1 clic", smallSub: "Notion / Obsidian / PDF / Word", promoTitle: `Synchronisez ${p} en 1 clic`, promoSub: "Enregistrez dans Notion, Obsidian ou en fichiers locaux.", batchLabel: "Export et synchro par lot", batchSub: "Traitez plusieurs chats", privateLabel: "Fichiers locaux privés", privateSub: "Le chat reste dans votre navigateur", pipelineTitle: "Traitement local et direct", pipelineSub: `${p} reste dans votre navigateur`, noServerTitle: "Sans serveur de conversion", noServerSub: "Synchro directe et fichiers locaux", noUploadTitle: "Synchro privée", noUploadSub: "exécution dans le navigateur", notionBody: "Base de données", obsidianBody: "Coffre local", localFilesBody: "Fichiers locaux",
    },
    ja: {
      slide1: { label: "同期と書き出し", title: ["ワンクリック同期", "Notion / Obsidian"], body: [`${p} の会話をナレッジベースへ同期、`, "または整ったローカルファイルへ保存。"], bullets: ["Notion / Obsidian へワンクリック同期", "PDF・Word・Markdown・HTML・画像・テキスト", `${p} 専用` ] },
      slide2: { label: "一括書き出しと同期", title: ["チャットを一括", "書き出し・同期"], body: [`複数の ${p} 会話をファイルへ保存、`, "または Notion / Obsidian へ同期。"], bullets: ["ファイルを一括書き出し", "Notion / Obsidian へ一括同期", "最大10件の会話を処理"], cardTitle: "一括処理の準備完了", cardBody: "会話と保存先を選択", cardStat: "書き出し・同期" },
      smallTitle: "ワンクリック同期", smallSub: "Notion / Obsidian / PDF / Word", promoTitle: `${p} をワンクリック同期`, promoSub: "Notion、Obsidian、またはローカルファイルへ保存。", batchLabel: "一括書き出し・同期", batchSub: "複数チャットを処理", privateLabel: "非公開のローカル保存", privateSub: "会話はブラウザ内に保持", pipelineTitle: "ローカル処理と直接同期", pipelineSub: `${p} の内容はブラウザ内に保持`, noServerTitle: "変換サーバー不要", noServerSub: "直接同期とローカル保存", noUploadTitle: "非公開の同期", noUploadSub: "ブラウザ内で実行", notionBody: "データベース", obsidianBody: "ローカル保管庫", localFilesBody: "ローカル保存",
    },
    ko: {
      slide1: { label: "동기화 및 내보내기", title: ["원클릭 동기화", "Notion / Obsidian"], body: [`${p} 대화를 지식 베이스에 동기화하거나`, "깔끔한 로컬 파일로 즉시 저장하세요."], bullets: ["Notion / Obsidian 원클릭 동기화", "PDF, Word, Markdown, HTML, 이미지, 텍스트", `${p} 전용`] },
      slide2: { label: "일괄 내보내기 및 동기화", title: ["채팅 일괄", "내보내기·동기화"], body: [`여러 ${p} 대화를 파일로 저장하거나`, "Notion / Obsidian에 한 번에 동기화하세요."], bullets: ["로컬 파일 일괄 내보내기", "Notion / Obsidian 일괄 동기화", "한 번에 최대 10개 대화"], cardTitle: "일괄 처리 준비 완료", cardBody: "대화와 대상을 선택", cardStat: "내보내기·동기화" },
      smallTitle: "원클릭 동기화", smallSub: "Notion / Obsidian / PDF / Word", promoTitle: `${p} 원클릭 동기화`, promoSub: "Notion, Obsidian 또는 로컬 파일로 저장하세요.", batchLabel: "일괄 내보내기·동기화", batchSub: "여러 채팅을 처리", privateLabel: "비공개 로컬 파일", privateSub: "대화는 브라우저에 유지", pipelineTitle: "로컬 처리 및 직접 동기화", pipelineSub: `${p} 내용은 브라우저에 유지`, noServerTitle: "변환 서버 없음", noServerSub: "직접 동기화 및 로컬 파일", noUploadTitle: "비공개 동기화", noUploadSub: "브라우저에서 실행", notionBody: "데이터베이스", obsidianBody: "로컬 보관함", localFilesBody: "로컬 파일",
    },
    "pt-BR": {
      slide1: { label: "Sincronize e exporte", title: ["Sincronize em 1 clique", "Notion / Obsidian"], body: [`Salve chats do ${p} na sua base de conhecimento`, "ou exporte arquivos prontos imediatamente."], bullets: ["Notion / Obsidian em 1 clique", "PDF, Word, Markdown, HTML, imagem e texto", `Somente para ${p}`] },
      slide2: { label: "Exportação e sync em lote", title: ["Exporte e sincronize", "vários chats"], body: [`Exporte vários chats do ${p} como arquivos`, "ou sincronize com Notion / Obsidian."], bullets: ["Exportação de arquivos em lote", "Notion / Obsidian em lote", "Até 10 conversas de uma vez"], cardTitle: "Pronto para processar", cardBody: "Escolha chats e destino", cardStat: "Exporte ou sincronize" },
      smallTitle: "Sincronize em 1 clique", smallSub: "Notion / Obsidian / PDF / Word", promoTitle: `Sincronize ${p} em 1 clique`, promoSub: "Salve no Notion, Obsidian ou em arquivos locais.", batchLabel: "Exportação e sync em lote", batchSub: "Processe vários chats", privateLabel: "Arquivos locais privados", privateSub: "O chat permanece no navegador", pipelineTitle: "Processamento local e direto", pipelineSub: `${p} permanece no navegador`, noServerTitle: "Sem servidor de conversão", noServerSub: "Sync direto e arquivos locais", noUploadTitle: "Sync privado", noUploadSub: "execução no navegador", notionBody: "Banco de dados", obsidianBody: "Cofre local", localFilesBody: "Arquivos locais",
    },
  };

  const reportTitles = {
    en: ["Turn chats", "into reports"],
    "zh-CN": ["将聊天", "整理成报告"],
    "zh-TW": ["把對話", "整理成報告"],
    de: ["Chats zu", "Berichten machen"],
    es: ["Convierte chats", "en informes"],
    fr: ["Transformez vos", "chats en rapports"],
    ja: ["チャットを", "レポートに変換"],
    ko: ["채팅을", "보고서로 변환"],
    "pt-BR": ["Transforme chats", "em relatórios"],
  };

  const result = {
    ...copy[locale],
    ...syncOverrides[locale],
    slide1: syncOverrides[locale].slide1,
    slide2: syncOverrides[locale].slide2,
    slide5: {
      ...copy[locale].slide5,
      title: reportTitles[locale],
    },
  };
  if (!result) throw new Error(`Missing store copy for locale: ${locale}`);
  return result;
}
