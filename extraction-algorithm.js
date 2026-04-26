/* ============================================================
 * extraction-algorithm.js
 * Meta-Analysis Data Extractor — 抽出アルゴリズム本体
 * ----------------------------------------------------------------
 * ここには「どうやって論文からデータを抽出するか」を定義する。
 *   - システムプロンプト（抽出 / Critic / Verify）
 *   - JSONスキーマ（抽出結果の構造）
 *   - プロンプトビルダー（PICO・選択範囲・補完・再抽出）
 *   - 抽出パイプライン本体（runExtractionPipeline）
 *
 * 含まないもの（HTML側に残る）:
 *   - APIキー管理 / ローテーション
 *   - Gemini呼び出し（callGemini）/ 503・429ハンドリング
 *   - PDFテキスト・画像抽出（PDF.js）
 *   - React UI 全般
 *
 * 使い方:
 *   1) HTMLの<head>でこのファイルを <script src="extraction-algorithm.js"> として読み込む
 *   2) HTML側で callGemini 等のインフラ関数を定義した後、
 *        ExtractionAlgorithm.configure({ callGemini, makeKeyRotator, GEMINI_MODELS,
 *                                        extractPdfText, getPdfBase64, extractPdfImages });
 *      を呼んで依存を登録する（必須・未登録時はエラー）
 *   3) パイプラインや各プロンプトビルダーは ExtractionAlgorithm.* から参照する
 *
 * 更新の指針:
 *   - プロンプト改良は SYSTEM_PROMPT_* または build*Prompt() を直接編集
 *   - スキーマ拡張は EXTRACT_SCHEMA_JSON に追加（Gemini版は自動再生成）
 *   - パイプライン段数や順序を変える場合は runExtractionPipeline() を編集
 * ============================================================ */
(function (global) {
  'use strict';

  const VERSION = '1.0.0';

  /* ============================================================
   * 依存登録 (configure)
   * ============================================================ */
  const REQUIRED_DEPS = [
    'callGemini', 'makeKeyRotator', 'GEMINI_MODELS',
    'extractPdfText', 'getPdfBase64', 'extractPdfImages'
  ];
  let __deps = null;

  function configure(deps) {
    if (!deps || typeof deps !== 'object') {
      throw new Error('[ExtractionAlgorithm] configure() の引数がオブジェクトではありません');
    }
    const missing = REQUIRED_DEPS.filter(k => typeof deps[k] === 'undefined' || deps[k] === null);
    if (missing.length) {
      throw new Error('[ExtractionAlgorithm] 必須依存が未登録: ' + missing.join(', '));
    }
    __deps = deps;
  }

  function ensureConfigured() {
    if (!__deps) {
      throw new Error('[ExtractionAlgorithm] configure() を先に呼んでください（HTML側でインフラ関数を未登録）');
    }
    return __deps;
  }

  /* ============================================================
   * SYSTEM PROMPTS（精度最大化のための強化版）
   * ============================================================ */
  const SYSTEM_PROMPT_EXTRACT = `あなたは世界最高水準の医学システマティックレビュー/メタ分析の熟練専門家です。20年以上の臨床研究経験を持ち、Cochrane Handbookの隅々まで精通しています。

【使命】提供されたRCT論文から、メタ分析に必要な**数値データ**を「完全無欠の精度」で抽出する。evidenceText（根拠文）だけでなく、**そこに含まれる全ての数値を必ず構造化フィールドに格納すること**。

【🚨 最重要・絶対遵守ルール】
**evidenceText に書いた数値は、必ず構造化フィールド（n_total, events_or_mean, sd_or_se, effectEstimate.value 等）にも転記すること**。evidenceText だけ書いて数値フィールドが空のレコードは厳禁。
- evidence: "121 teeth examined at 5-year, 80% success in PCR, 56% in SW (p=0.36)"
  → 必ず: interventionGroup.n_total="121", interventionGroup.events_or_mean="80%" (or actual count), comparisonGroup.events_or_mean="56%", effectEstimate.pValue="0.36"
- evidence: "229 teeth randomized; PCR group n=114, SW group n=115"
  → 必ず: interventionGroup.n_total="114", comparisonGroup.n_total="115"
- 数値が "%" のみで実数が無くても、events_or_mean に "80%" と入れる（空にしない）
- "p < 0.001" → effectEstimate.pValue="<0.001"
- 95%CI が "0.21-4.08" → effectEstimate.ci95="0.21-4.08"

【出力例 — 必ずこの粒度で全フィールド埋める】

例1（Binary / 二値変数）:
{
  "actualOutcomeName": "5年生存率（PCR vs SW）",
  "timePoint": "5年",
  "variableType": "Binary",
  "populationType": "ITT",
  "interventionGroup": { "n_total": "114", "events_or_mean": "91 (80%)", "sd_or_se": "-" },
  "comparisonGroup":   { "n_total": "115", "events_or_mean": "64 (56%)", "sd_or_se": "-" },
  "effectEstimate": { "measureType": "IRR", "value": "0.38", "ci95": "0.23-0.63", "pValue": "0.001" },
  "evidenceText": "Survival analysis showed success rates of 80% in PCR group (91/114) and 56% in SW group (64/115), IRR 0.38 (95%CI 0.23-0.63, p=0.001)",
  "evidenceTextJa": "生存解析では PCR群80% (91/114)、SW群56% (64/115)、IRR 0.38 (95%CI 0.23-0.63, p=0.001)",
  "sourceLocation": "本文 p.5 段落2 + Table 2",
  "pageNumber": 5,
  "confidence": "high",
  "sdOrSe": "-",
  "figureType": "None"
}

例2（Continuous / 連続変数 — change from baseline）:
{
  "actualOutcomeName": "12週時のHbA1c変化量（baselineからの変化）",
  "timePoint": "12週",
  "variableType": "Continuous",
  "populationType": "ITT",
  "interventionGroup": { "n_total": "150", "events_or_mean": "-1.2", "sd_or_se": "0.8" },
  "comparisonGroup":   { "n_total": "148", "events_or_mean": "-0.4", "sd_or_se": "0.7" },
  "effectEstimate": { "measureType": "MD", "value": "-0.8", "ci95": "-1.0 to -0.6", "pValue": "<0.001" },
  "evidenceText": "Mean change in HbA1c from baseline at 12 weeks was -1.2% (SD 0.8) in SGLT2 group vs -0.4% (SD 0.7) in placebo (mean difference -0.8%, 95%CI -1.0 to -0.6, p<0.001)",
  "evidenceTextJa": "12週時のHbA1c変化量はSGLT2群 -1.2% (SD 0.8)、プラセボ群 -0.4% (SD 0.7) (平均差 -0.8%, 95%CI -1.0 to -0.6, p<0.001)",
  "sourceLocation": "Table 3",
  "pageNumber": 6,
  "confidence": "high",
  "sdOrSe": "SD",
  "figureType": "None"
}

例3（Time-to-event / KMカーブ + Table 併記）:
{
  "actualOutcomeName": "全死亡（Time-to-event）",
  "timePoint": "中央値追跡 36ヶ月",
  "variableType": "TimeToEvent",
  "populationType": "ITT",
  "interventionGroup": { "n_total": "500", "events_or_mean": "85 (17.0%)", "sd_or_se": "-" },
  "comparisonGroup":   { "n_total": "503", "events_or_mean": "112 (22.3%)", "sd_or_se": "-" },
  "effectEstimate": { "measureType": "HR", "value": "0.72", "ci95": "0.54-0.96", "pValue": "0.026" },
  "evidenceText": "All-cause mortality occurred in 85/500 (17.0%) intervention vs 112/503 (22.3%) control patients (HR 0.72, 95%CI 0.54-0.96, log-rank p=0.026, median follow-up 36 months)",
  "evidenceTextJa": "全死亡は介入群 85/500 (17.0%)、対照群 112/503 (22.3%) で発生（HR 0.72, 95%CI 0.54-0.96, log-rank p=0.026, 中央値追跡36ヶ月）",
  "sourceLocation": "Figure 2 KMカーブ + Table 4",
  "pageNumber": 8,
  "confidence": "high",
  "sdOrSe": "-",
  "figureType": "KaplanMeier"
}

【思考プロセス（必須）】
以下の順序で体系的に情報を収集してください：
1. まず論文の全体構造を把握（Abstract, Methods, Results, Tables, Figures, Supplementaryの有無）
2. PICOを特定し、群構成（2群/3群以上）を確認
3. CONSORT flow diagram / Participants セクションから ITT/PP/mITT 等の集団数を確認
4. Results本文を段落ごとに精読し、全ての数値を拾う
5. 全Tableを項目ごとに精査（Table 1 = baseline, Table 2+ = outcomes が典型）
6. Figure（Kaplan-Meier, Forest plot等）の読み取り
7. Abstractとの整合性チェック（不一致は両方保持）

【最重要原則：揺らぎの完全保持】
1. 指定外のアウトカムも全て抽出（requestedOutcomeName="未指定（論文から自動抽出）"）
2. Abstract と本文に数値の違いがある場合 → 両方を別レコードとして抽出、variationReasonに記載
3. 連続変数の「術前 / 術後 / 変化量 (change from baseline)」→ 3つ全て独立アウトカム
4. ITT vs PP vs mITT vs Safety population → 統合せず独立して抽出、populationTypeに明記
5. 時点が複数（e.g., 4週・12週・24週）→ 時点ごとに別レコード
6. 同じアウトカムが異なるサブグループで報告 → 独立抽出
7. 異なる計算方法（例: last-observation-carried-forward vs multiple imputation）→ 別レコード

【群のペアリング（超重要）】
同じアウトカム・同じ時点・同じ集団タイプの介入群と対照群データは必ずペアで格納。
片方だけの抽出は厳禁。3群以上ある場合は thirdGroup にも格納。

【出処の厳密な分離】
sourceLocationには単一の出処のみ記載（例: "Table 2", "Abstract Results", "Figure 2", "本文p.5段落3"）。
記載場所が違えば必ず別レコード。「Table 2 / Figure 2」のような複合記載は禁止。

【データ抽出の厳密ルール】
1. 文献番号（例: "Smith et al [15]"）は除外
2. カンマ/ピリオド/スペースを数値区切りとして誤解釈しない（例: "1,234" = 1234, "1.234" = 小数, 言語圏に注意）
3. SD (Standard Deviation) と SE (Standard Error) の厳格区別:
   - 明示表記を最優先 (e.g., "mean ± SD", "mean (SE)")
   - "±"記号の後の値は通常SD（但し必ず文脈確認）
   - "(95% CI: a, b)" → 95%信頼区間、SD/SEとは別
   - SEの場合は notes に必ず "SE記載（SD変換要：SD = SE × √n）" と記載
4. 二値変数（Binary）:
   - 実数 n (events/total) を絶対優先抽出
   - percent のみの場合は実数を逆算し notes に記載
   - ゼロイベントは必ず "0" として記録（空欄禁止）
   - 効果指標: RR, OR, HR, RD, ARR, NNT, 95%CI, P値すべて抽出
5. 連続変数（Continuous）:
   - N, mean, SD (or SE), median, IQR, range を全て抽出
   - 中央値のみの場合 notes に "中央値のみ（平均変換要検討）"
   - Mean difference, 95%CI, P値を抽出
6. Time-to-event: HR, 95%CI, log-rank P値、群別 N、events、median follow-up
7. 記載がない項目は "不明" と出力。推測・補間は厳禁
8. pageNumber に PDFページ番号（1始まり）を整数で必ず記載
9. evidenceText には**元文献の原文をそのまま**引用（改変禁止、数値を含む完全な文）。画像（図表）から抽出した場合はセル値や軸ラベル・凡例を可能な限り文字起こし
10. evidenceTextJa は **evidenceText の自然な日本語訳**（数値・略語はそのまま）。図表からの場合は「[Figure 2 (KMカーブ) からの読取り] 介入群の12ヶ月生存率は78%」のように出典を明示

【🔍 図・表からの抽出（必須・最重要）】
論文添付の高解像度画像を必ず精査し、以下の図表からも数値を抽出してください：
- **Table（表）**: 全行・全セルを精読。Table 1 = baseline, Table 2+ = outcomes が典型。表のヘッダー（行/列）を識別し、群×アウトカムの交点の数値を正確に拾う
- **Bar chart / Line chart（棒/折れ線グラフ）**: Y軸目盛りと棒/点の高さを丁寧に読み取り、近似値と判定理由を notes に記載（例: "Fig 2 棒グラフから目視推定: 介入群 ~78%, エラーバー ~5%"）
- **Kaplan-Meier カーブ**: 各群の特定時点（6ヶ月/12ヶ月/最終フォロー）の生存率、median survival、at-risk数（カーブ下のテーブル）を抽出。HR/95%CI/log-rank Pは別途抽出
- **Forest plot**: メタ分析論文内のforest plotがあれば各サブグループの効果量・CIを抽出
- **Boxplot**: median, IQR, range を box とヒゲから読み取る
- 図表からの読み取りは confidence="low" または "medium" に設定し、figureType フィールドに種別を記録、notes に "[図表からの目視抽出]" と明記

【CONSORT Flow Diagramからの抽出（重要）】
Figure 1 (CONSORT) から以下を抽出:
- Randomized N
- Allocated to each arm N
- Received intervention N
- Lost to follow-up N (理由別)
- Analyzed (ITT) N / Analyzed (PP) N
これらは populationType ごとの n_total として使用。

【Table 1 (Baseline) の完全抽出】
全行を baselineCharacteristics に抽出。年齢・性別は必須。
category は "人口統計"/"病歴"/"検査値"/"介入前スコア"等で分類。

【評価の確信度（confidence）】
各抽出項目に confidence を付与:
- "high": 明示的数値が単一箇所から抽出（例: Table セル値）
- "medium": 計算/換算が含まれる、または複数箇所で微妙に異なる
- "low": 図表から目視推定、または間接的記載から推論

【expertCommentary（日本語で必須）】
以下を含めること:
- 主要アウトカムの揺らぎポイントとその原因
- SD/SE変換が必要な項目
- ITT/PP集団の差異
- メタ分析実装時の注意点（例: "中央値のみ報告、Wan et al 2014法でSD推定推奨"）
- 論文の質的リスク（報告バイアス、選択バイアス等の兆候）

【絶対厳禁】
❌ 推測による数値補完
❌ 類似アウトカムの統合
❌ Abstract と本文の数値統一
❌ SD と SE の混同
❌ ゼロイベントを空欄として省略
❌ evidenceText の改変・要約

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【📚 Cochrane Handbook 準拠 抽出精度ルール（既存ルールを補強）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
※ 新フィールドは追加しない。既存の actualOutcomeName / populationType / notes に構造化タグで記録すること。

■ アウトカム5要素で別レコード化（最重要）
以下5要素のうち1つでも違えば別レコード:
  (1) domain（疼痛/感染/最大開口量等）
  (2) measurement tool（VAS 0-100, NRS 0-10, mm 等）
  (3) metric（術後値 / 変化量 / 群間差 / ANCOVA調整済み差）
  (4) aggregation（mean+SD / mean+SE / median+IQR / events/total / HR+CI）
  (5) time point（術後24h, 1週, 3か月 等）

actualOutcomeName に metric を必ず含めて区別する:
- "VAS 24h 安静時痛 平均/SD（術後値）"
- "VAS 24h 安静時痛 平均/SD（baseline からの変化量）"
- "VAS 24h 安静時痛（ANCOVA調整済み MD）"

■ 二値アウトカム = イベント数 + 分母を常にセット
分母（randomized / ITT / mITT / PP / available case / safety）を populationType に明記。
パーセントのみで実数不明なら notes に "[%のみ：分母確認要]" を記録。

■ 変換時は notes に式を残す（履歴必須）
SE→SD, CI→SD, HR反転 等を行ったら notes に明記:
- "[変換: SD = SE × √n = 0.4 × √25 = 2.0]"
- "[変換: SD = √n × (Upper-Lower)/3.92]"
- "[変換: SE_MD = (Upper-Lower)/3.92]"
- "[HR反転: 元値=control vs intervention のため 1/HR を採用]"
- 変化量SDを相関仮定で推定: "[仮定: r=0.5（感度分析対象）]"

■ HRの向きを必ず確認
intervention vs control が標準。逆向きなら反転（HR_rev=1/HR, lower_rev=1/upper, upper_rev=1/lower）し、notes に "[HR向き: 元は control vs intervention、反転済み]" を記録。
adjusted HR の場合は notes に "[調整因子: age, sex, BMI 等]" を記載。

■ 多群試験の対照群再利用に注意
3群以上で同じ対照群を複数比較で使うと二重カウント。notes に処理方法を明記:
- "[多群: 介入群統合]"
- "[多群: 対照群分割]"
- "[多群: 別比較として独立]"

■ 特殊デザインを明示
crossover / cluster / split-mouth / matched / 両側部位デザインは並行群RCTとして扱うと危険。
notes に "[特殊デザイン: split-mouth]" 等を必ず記録。

■ 著者照会トリガー
以下の場合 notes に "[著者照会推奨: <理由>]" を明記:
- SDなし / SE-SD区別不明
- change score SDなし
- 図のみで数値なし
- ITT-PP混在
- HRあるがCIなし
- 論文内・registry と数字が矛盾

■ 落とし穴フラグ（該当時 notes に追加）
- "[落とし穴: 分母不一致]" Baseline n と解析 n が違う
- "[落とし穴: SE/SD不明]" 表記が曖昧
- "[落とし穴: 術後値/変化量混同]"
- "[落とし穴: scale混在]" VAS 0-10 と 0-100 が混在
- "[落とし穴: HR向き不明]"
- "[落とし穴: 多群対照重複]"
- "[落とし穴: p値のみ]" p<0.05 のみで精密値なし
- "[落とし穴: 有害事象分母]" safety vs efficacy population
- "[落とし穴: registry不一致]"

■ ソース優先順位（出処の階層）
1. 本文・表・補足の数値 → 2. trial registry → 3. 図注 → 4. グラフからの目視抽出
グラフ抽出時は confidence="low" or "medium"、notes に "[図表からの目視抽出]" を必ず付与。
論文と registry/supplement で値が違えば両方を別レコードで保持。

■ 複数時点・類似アウトカム
- 同研究の異なる時点（24h / 48h / 1w）は別レコード
- 類似アウトカム（pain at rest / on movement / worst / average / on chewing）は混ぜず独立抽出

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【🎯 2群比較RCT専用 + 連続量パターン網羅（最重要・絶対遵守）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 本アプリは2群比較RCT専用（介入群 vs 対照群）
- **イベント数 / 症例数(N) / 平均値 / SD は必ず介入群と対照群の両方を抽出**（片方のみは厳禁）
- 片方しか論文/選択範囲に見当たらない場合でも、周辺テキスト・他Table・本文を参照して両群を埋める努力をする
- それでも対照群データが見つからない場合のみ、notes に "[警告: 対照群データ未確認 — 要確認]" を明記して両フィールドの分かる方を残す
- HR / RR / OR / MD / SMD は2群を統合した単一指標のため effectEstimate に1値で記録可（向きは notes に明記）
- 3群試験の場合: 最も関連する2群比較（介入 vs 対照）に絞って抽出。thirdGroup フィールドは原則使用しない

■ 連続量は術前/術後/変化量の全パターンを別レコードで抽出（最重要）
論文に術前値・術後値・変化量・群間差が併記されている場合、**全パターンを独立レコードで抽出**する（後で利用者が選択できるように）:
  (1) 術前値 (baseline / pre-op): 各群の mean ± SD
  (2) 術後値 (post-op / follow-up at time T): 各群の mean ± SD
  (3) 変化量 (change = post − pre): 各群の mean ± SD
  (4) 変化量 (change = pre − post): 符号反対（論文表記に従う）
  (5) 群間差 (between-group MD): 単一値 + 95%CI + p
  (6) ANCOVA調整済み群間差: 単一値 + 95%CI + p

actualOutcomeName に必ずパターンを明記:
  - "HbA1c 術前値 mean/SD"
  - "HbA1c 12週時 mean/SD（術後値）"
  - "HbA1c 12週時の変化量 (post-pre) mean/SD"
  - "HbA1c 12週時 群間差 (MD)"
  - "HbA1c 12週時 ANCOVA調整済みMD"

notes に必ず以下のいずれかを付与:
  "[術前]" / "[術後]" / "[変化量 post-pre]" / "[変化量 pre-post]" / "[群間差MD]" / "[ANCOVA調整]"

論文に複数パターンが併記されているのに1パターンしか抽出しないのは情報損失。**見つかった全パターンを必ず独立レコードで保持**。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【📖 PDF 精読プロセス（数字を拾う前に「意味」を必ず確認）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

数字だけを抜くと高確率で誤抽出。必ず以下の順で「数字の意味を定義する場所」を先に確認すること:

■ Step A: Methods で outcome 定義・分母・スケールを先に把握
- outcome 正式名称・測定時点・スケール（VAS 0-10 vs 0-100）と方向（higher=worse/better）
- analysis population の定義: ITT / mITT / PP / safety / FAS / available case / complete case
- 統計モデル: ANCOVA / Cox / mixed model / LS mean / 調整因子 / 欠測処理（LOCF/MI）
これらを把握してから Results の数字を読む。

■ Step B: CONSORT Flow Diagram で n の種類を区別（最重要）
- randomized n → ITT分母候補（研究記述用）
- allocated → 群ごとの割付数
- received → safety population 候補
- analysed (per outcome) → そのアウトカムの解析分母 ★これを最優先
- excluded / lost to follow-up → 欠測リスク
⚠ baseline table の n を outcome 分母として**自動流用禁止**（多くの場合異なる）。

■ Step C: 表の脚注は必ず読む（SD/SE 判別はここで決定）
- "Data are mean ± SD" → そのまま使用
- "Data are mean ± SE" / "± SEM" → SD = SE × √n に変換し notes に式を記録
- "Values are median (IQR)" → mean/SD として扱わない（変換要検討）
- "based on available data" / "patients with available outcome" → 分母 ≠ randomized
- "Safety population" → 有害事象用、効果アウトカムと混ぜない
- "LS mean" / "adjusted for baseline" → 群別 mean/SD ではなく ANCOVA調整値
- "Error bars indicate SEM/SD/95%CI" → エラーバーの種類確認
- "Higher scores indicate worse/better" → スケール方向確認

■ Step D: 分母単位の確認（per-patient vs per-tooth/lesion）
歯科・眼科・整形・両側臓器・複数病変・複数治療サイクルでは「20 patients / 40 teeth」のように分母単位が違う。
ランダム化単位（通常 patient）と一致しない場合は notes に "[分母単位: teeth / lesions / cycles 等]" を必ず明記。

■ Step E: KM 曲線の罠
"number at risk" は **リスク集合残存数であってイベント数ではない**（絶対混同しない）。
HR は KM 曲線の図中・図脚注・Cox table・本文に小さく記載されることが多い（必ず探す）。
HR の reference group（intervention vs control の向き）を必ず確認、逆なら反転。

■ Step F: 論文内で n が違う場合は全部記録
Abstract / flow / baseline / outcome table で n が異なるのは意味が違うから:
- randomized / analysed / safety / PP の区別を意識
- 統一せず、各レコードに適切な n を選択
- 不一致を notes に "[n不一致: randomized=120 / analysed=110 / safety=118]" として記録

■ Step G: Supplementary / Appendix を必ず確認
secondary outcomes 詳細・各時点 mean/SD・subgroup・sensitivity analysis・PP 結果・有害事象詳細・調整/非調整両方は Supplement に集約されることが多い。
sourceLocation に "Supplementary Table SX" / "eTable Y" / "Appendix Table" を明記。

■ 検索キーワードのヒント
- 解析集団: intention / ITT / modified / per protocol / safety / full analysis / complete case
- 連続量: mean / SD / SE / SEM / median / IQR / change from baseline / ANCOVA / LS mean / adjusted
- 二値: n (%) / events / proportion / response / success / failure / complication / adverse
- HR: hazard / Cox / Kaplan / log-rank / number at risk / censored / progression
- 図脚注: Error bars indicate / Data are mean ± / Higher scores indicate

■ 抽出時の鉄則
**「どのアウトカム / どの時点 / どの解析集団 / どの分母 / どの統計量」を数字とセットで必ず記録**。
これらが揃っていない単独の数字は抽出しない（または confidence="low" + notes に欠落項目を明記）。`;

  const SYSTEM_PROMPT_CRITIC = `あなたは医学メタ分析データ抽出の監査役（Critic）です。Cochrane EPOCの Risk-of-bias 評価者として活動してきた世界有数の専門家です。

【使命】
別のAIが抽出したデータを論文原文と照合し、誤り・欠落・曖昧さを徹底的に指摘して訂正する。
あなたの仕事はメタ分析の数値の1桁の誤りも見逃さないことです。

【レビュー手順】
1. 抽出された各アウトカムの evidenceText を論文原文と照合
2. 数値が evidenceText から確実に読み取れるか検証
3. SD と SE の識別が正しいか確認（± 記号の解釈を特に注意）
4. ITT/PP集団の分離が正しいか確認
5. 3群目の見落としがないか確認
6. Abstract と本文の数値差異が別レコードとして保持されているか確認
7. baseline の年齢・性別は抽出されているか確認
8. CONSORT flow diagramからのN数が extractedOutcomes に反映されているか
9. 時点違い・サブグループ違いが統合されていないか
10. 変化量（change from baseline）が術前・術後と別レコードになっているか

【出力】
correctionsにオブジェクトの配列として出力:
- targetType: "outcome" | "baseline" | "global"
- targetIndex: 対象のインデックス（globalの場合-1）
- field: 問題のあるフィールド名
- severity: "critical" | "warning" | "info"
- issue: 問題の詳細説明
- proposedFix: 修正案（可能なら具体的な値）
- evidenceForFix: 修正の根拠となる原文引用

missingOutcomes配列に見落とされた可能性のあるアウトカムを列挙。
overallAssessmentに総合評価と信頼度スコア(0-100)を記載。`;

  const SYSTEM_PROMPT_VERIFY = `あなたは単一のアウトカム抽出レコードを原論文と照合する検証エキスパートです。

与えられた1つの抽出済みアウトカムに対して：
1. evidenceText（根拠原文）に n_total, events_or_mean, sd_or_se の数値が実際に含まれているか確認
2. 数値がevidenceText内のどの位置に出現するか特定
3. SD/SEの判定が evidenceText の表記と矛盾していないか確認
4. 論文のその周辺情報から判断して、populationType や timePoint が正しいか確認

出力は単一JSONオブジェクト:
{
  "verified": true/false,
  "issues": ["問題点のリスト"],
  "confidence": 0-100,
  "correctedValues": { /* 必要な場合のみ */ },
  "notes": "検証コメント"
}`;

  // パイプライン Stage4 (Critic監査) で使う短い system prompt（runExtractionPipeline 内で使用）
  const CRITIC_PIPELINE_SYSTEM_PROMPT = `あなたはメタ分析データ抽出の監査専門家です。Cochrane EPOC の risk-of-bias 評価者として活動してきた世界有数の専門家です。1桁の数値ミスも見逃さず、原文との照合で修正済み outcomes を返答します。`;

  // 選択範囲の自動補完・再抽出で使う短い system prompt
  const NUMERIC_FOCUSED_SYSTEM_PROMPT = `数値抽出に特化した分析専門家として、要求された JSON だけを出力してください。`;

  /* ============================================================
   * RESPONSE SCHEMAS
   * ============================================================ */
  const EXTRACT_SCHEMA_JSON = {
    type: "object",
    properties: {
      paperPICO: {
        type: "object",
        properties: {
          P: { type: "string" }, I: { type: "string" }, C: { type: "string" },
          thirdGroup: { type: "string" }, studyDesign: { type: "string" },
          sampleSize: { type: "string" }, followUpDuration: { type: "string" }
        }
      },
      consortFlow: {
        type: "object",
        description: "CONSORT flow diagram からの抽出",
        properties: {
          randomized: { type: "string" },
          allocatedIntervention: { type: "string" },
          allocatedComparison: { type: "string" },
          allocatedThird: { type: "string" },
          analyzedITT_intervention: { type: "string" },
          analyzedITT_comparison: { type: "string" },
          analyzedPP_intervention: { type: "string" },
          analyzedPP_comparison: { type: "string" },
          lostToFollowUp_intervention: { type: "string" },
          lostToFollowUp_comparison: { type: "string" },
          sourceLocation: { type: "string" }, pageNumber: { type: "integer" }
        }
      },
      statisticalMethods: { type: "array", items: { type: "string" } },
      baselineCharacteristics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string" }, variable: { type: "string" },
            interventionGroup: { type: "object", properties: { n:{type:"string"}, value:{type:"string"}, sd:{type:"string"}, percent:{type:"string"}, iqr:{type:"string"}, range:{type:"string"} }},
            comparisonGroup: { type: "object", properties: { n:{type:"string"}, value:{type:"string"}, sd:{type:"string"}, percent:{type:"string"}, iqr:{type:"string"}, range:{type:"string"} }},
            thirdGroup: { type: "object", properties: { n:{type:"string"}, value:{type:"string"}, sd:{type:"string"}, percent:{type:"string"}, iqr:{type:"string"}, range:{type:"string"} }},
            pValue: { type: "string" }, unit: { type: "string" }, dataType: { type: "string" },
            sourceLocation: { type: "string" }, pageNumber: { type: "integer" },
            confidence: { type: "string" }
          },
          required: ["variable", "dataType"]
        }
      },
      extractedOutcomes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            requestedOutcomeName: { type: "string" }, actualOutcomeName: { type: "string" },
            timePoint: { type: "string" }, variationReason: { type: "string" },
            calculationMethod: { type: "string" }, variableType: { type: "string" },
            populationType: { type: "string" }, populationDescription: { type: "string" },
            interventionGroup: { type: "object", properties: { n_total:{type:"string"}, events_or_mean:{type:"string"}, sd_or_se:{type:"string"} }},
            comparisonGroup: { type: "object", properties: { n_total:{type:"string"}, events_or_mean:{type:"string"}, sd_or_se:{type:"string"} }},
            thirdGroupName: { type: "string" },
            thirdGroup: { type: "object", properties: { n_total:{type:"string"}, events_or_mean:{type:"string"}, sd_or_se:{type:"string"} }},
            effectEstimate: { type: "object", properties: { measureType:{type:"string"}, value:{type:"string"}, ci95:{type:"string"}, pValue:{type:"string"} }},
            evidenceText: { type: "string", description: "原文の英語(または論文言語)を改変せず引用。表/図からの場合は表セル・軸ラベル等を文字起こし" },
            evidenceTextJa: { type: "string", description: "evidenceText の日本語訳（数値はそのまま、医学用語は適切に訳出）" },
            figureType: { type: "string", description: "出典が図表の場合の種別: Table | BarChart | LineChart | KaplanMeier | ForestPlot | Boxplot | None" },
            sourceLocation: { type: "string" },
            notes: { type: "string" }, pageNumber: { type: "integer" },
            confidence: { type: "string" }, sdOrSe: { type: "string" }
          },
          required: ["actualOutcomeName", "variableType", "evidenceText", "evidenceTextJa", "sourceLocation"]
        }
      },
      unclearItems: { type: "array", items: { type: "string" } },
      expertCommentary: { type: "string" },
      paperQualityAssessment: { type: "string" }
    },
    required: ["paperPICO", "statisticalMethods", "baselineCharacteristics", "extractedOutcomes", "unclearItems", "expertCommentary"]
  };

  // Gemini形式のスキーマ（OBJECT/STRINGを大文字に変換）
  function toGeminiSchema(s) {
    if (Array.isArray(s)) return s.map(toGeminiSchema);
    if (s && typeof s === 'object') {
      const r = {};
      for (const k in s) {
        if (k === 'type') r[k] = String(s[k]).toUpperCase();
        else if (k === 'description') continue; // Gemini schemaでは description は OK だが簡略化
        else r[k] = toGeminiSchema(s[k]);
      }
      return r;
    }
    return s;
  }
  const EXTRACT_SCHEMA_GEMINI = toGeminiSchema(EXTRACT_SCHEMA_JSON);

  // 軽量版スキーマ：応答サイズを抑え、出力トークン上限内で完走できるようにする
  // baselineCharacteristics / expertCommentary / paperQualityAssessment / consortFlow を除外
  const SLIM_EXTRACT_SCHEMA_JSON = {
    type: "object",
    properties: {
      paperPICO: EXTRACT_SCHEMA_JSON.properties.paperPICO,
      statisticalMethods: EXTRACT_SCHEMA_JSON.properties.statisticalMethods,
      extractedOutcomes: EXTRACT_SCHEMA_JSON.properties.extractedOutcomes,
      unclearItems: EXTRACT_SCHEMA_JSON.properties.unclearItems
    },
    required: ["paperPICO", "extractedOutcomes"]
  };
  const SLIM_EXTRACT_SCHEMA_GEMINI = toGeminiSchema(SLIM_EXTRACT_SCHEMA_JSON);

  // 補完用スキーマ：baseline + expertCommentary + paperQuality + consortFlow を別呼出で取得
  const SUPPLEMENT_SCHEMA_JSON = {
    type: "object",
    properties: {
      consortFlow: EXTRACT_SCHEMA_JSON.properties.consortFlow,
      baselineCharacteristics: EXTRACT_SCHEMA_JSON.properties.baselineCharacteristics,
      expertCommentary: EXTRACT_SCHEMA_JSON.properties.expertCommentary,
      paperQualityAssessment: EXTRACT_SCHEMA_JSON.properties.paperQualityAssessment
    }
  };
  const SUPPLEMENT_SCHEMA_GEMINI = toGeminiSchema(SUPPLEMENT_SCHEMA_JSON);

  // 単一アウトカム抽出用スキーマ：PDFの選択範囲（文字 or 画像）から1個のアウトカムを抽出
  const SINGLE_OUTCOME_SCHEMA_JSON = {
    type: "object",
    properties: EXTRACT_SCHEMA_JSON.properties.extractedOutcomes.items.properties,
    required: ["actualOutcomeName", "evidenceText"]
  };
  const SINGLE_OUTCOME_SCHEMA_GEMINI = toGeminiSchema(SINGLE_OUTCOME_SCHEMA_JSON);

  // Critic 監査用スキーマ：抽出結果を原文と照合して修正済み outcomes リストを返す
  const CRITIC_REVIEW_SCHEMA_JSON = {
    type: "object",
    properties: {
      correctedOutcomes: {
        type: "array",
        description: "原文と照合して修正済みの完全な outcomes リスト（元のリストの差分でなく全体）",
        items: EXTRACT_SCHEMA_JSON.properties.extractedOutcomes.items
      },
      issuesFound: {
        type: "array",
        description: "発見した誤りのサマリー（例: 「Outcome 3 で SD と SE が混同」）",
        items: { type: "string" }
      },
      addedOutcomes: {
        type: "array",
        description: "元のリストに無く新たに発見したアウトカム名のリスト",
        items: { type: "string" }
      },
      confidenceScore: { type: "integer", description: "総合信頼度 0-100" },
      overallAssessment: { type: "string", description: "総合評価コメント" }
    },
    required: ["correctedOutcomes", "confidenceScore"]
  };
  const CRITIC_REVIEW_SCHEMA_GEMINI = toGeminiSchema(CRITIC_REVIEW_SCHEMA_JSON);

  const CRITIC_SCHEMA = {
    type: "object",
    properties: {
      corrections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            targetType: { type: "string" }, targetIndex: { type: "integer" },
            field: { type: "string" }, severity: { type: "string" },
            issue: { type: "string" }, proposedFix: { type: "string" },
            evidenceForFix: { type: "string" }
          }
        }
      },
      missingOutcomes: { type: "array", items: { type: "string" } },
      overallAssessment: { type: "string" },
      confidenceScore: { type: "integer" }
    },
    required: ["corrections", "missingOutcomes", "overallAssessment", "confidenceScore"]
  };

  /* ============================================================
   * PROMPT BUILDERS
   *   - PICOブロック / 図プロンプト / メイン抽出ユーザープロンプト
   *   - 補完抽出プロンプト / Critic監査プロンプト
   *   - 選択範囲（テキスト / 画像）抽出プロンプト
   *   - 対照群自動補完プロンプト / 再抽出プロンプト
   * ============================================================ */
  function buildPicoBlock(pico, outcomes) {
    const namedOutcomes = (outcomes || []).filter(o => o.name && o.name.trim());
    const list = namedOutcomes.length
      ? namedOutcomes.map(o => `- ${o.name}${o.definition ? `: ${o.definition}` : ''}`).join('\n')
      : '全自動抽出モード（論文から全アウトカムを網羅）';
    return `【PICO設定】\nP: ${pico.p}\nI: ${pico.i}\nC: ${pico.c}\n\n【優先抽出アウトカム】\n${list}\n`;
  }

  function buildFigurePrompt(isMultimodal) {
    return isMultimodal
      ? `【重要】本文・表（Table）だけでなく、**図（Figure・グラフ・KMカーブ・棒/折れ線グラフ）からも数値を抽出**してください。画像は高解像度なので、軸目盛り・棒の高さ・カーブの位置を読み取り可能です。
- 図表から読み取った場合は figureType フィールド（"Table"/"BarChart"/"LineChart"/"KaplanMeier"/"ForestPlot"/"Boxplot"）に記録
- notes に「[図/表 X からの目視抽出]」と明記
- 確信度は medium または low に`
      : `【テキスト専用モード】このモデルは画像を読めないため、PDFから抽出済みのテキスト本文と表（Table のテキスト部分）からのみデータを抽出してください。図やグラフ（KMカーブ等）の数値が必要な場合は、本文中で言及された数値（"survival rate at 12 months was 78%" 等）を拾ってください。
- 表（Table）は通常テキストとして抽出されているので、行・列を識別してセル値を読み取ってください
- 画像のみに存在する数値（軸目盛り読取り）は抽出できないため、unclearItems に「[図XからのN値は要・目視確認]」と記載`;
  }

  function buildExtractionUserPrompt({ picoBlock, figurePrompt, evidenceCap, pdfText, isMultimodal }) {
    return `${picoBlock}
\n【タスク】
${isMultimodal ? '添付の論文PDF（テキスト + 高解像度画像）' : 'PDFから抽出されたテキスト'}を徹底的に精読し、上記PICO/アウトカム設定に従って **アウトカム数値データ** を抽出してください。

${figurePrompt}

【🚨 最重要】各 extractedOutcomes 項目で、**evidenceText に書いた数値は必ず構造化フィールド (interventionGroup, comparisonGroup, effectEstimate) にも転記**してください。
evidenceText だけ書いて数値フィールドが空のレコードは絶対に作らないこと。
- 例: 原文 "PCR group n=114, success 91/114 (80%); SW group n=115, success 64/115 (56%); IRR 0.38 (95%CI 0.23-0.63, p=0.001)"
  → interventionGroup.n_total="114", events_or_mean="91 (80%)"
  → comparisonGroup.n_total="115", events_or_mean="64 (56%)"
  → effectEstimate.value="0.38", ci95="0.23-0.63", pValue="0.001"

【⚠ 出力サイズ厳守 — 応答が途中で切れるのを防ぐ】
- evidenceText: ${evidenceCap}文字以内に**要約抜粋**（数値を含む核心部分のみ）。長文の場合は "..." で省略
- evidenceTextJa: 同じく${evidenceCap}文字以内
- **本コールではアウトカム数値の抽出に集中**。患者背景(baseline)・統計手法詳細・専門解説は別コールで取得するため、本JSONには含めない

各項目に必ず以下を含めてください：
- actualOutcomeName, timePoint, populationType, variableType
- interventionGroup / comparisonGroup の N・イベント数や平均・SD/SE（必須）
- effectEstimate（測定型・値・CI・P値）
- evidenceText（${evidenceCap}文字以内）+ evidenceTextJa（${evidenceCap}文字以内）
- pageNumber, sourceLocation, confidence

\n【参照テキスト（OCR済みPDF本文）】
${pdfText.substring(0, isMultimodal ? 40000 : 80000)}`;
  }

  function buildSupplementPrompt({ picoBlock, pdfText }) {
    return `${picoBlock}

【タスク】上記論文から以下のみを抽出してください（アウトカム数値は別コールで取得済みなので不要）：
1. consortFlow: CONSORT Flow Diagram のN数（無作為化/割付/解析/脱落）
2. baselineCharacteristics: Table 1 の患者背景（年齢・性別等）。各項目に介入群/対照群の n・値・SD・% を抽出
3. expertCommentary: メタ分析実装上の注意点（800文字以内）
4. paperQualityAssessment: 論文の質的評価（500文字以内）

【⚠ 出力サイズ厳守】expertCommentary 800文字以内、paperQualityAssessment 500文字以内、各 baseline 行の文字列値は短く

【参照テキスト】
${pdfText.substring(0, 40000)}`;
  }

  function buildCriticPrompt({ picoBlock, outcomesJson, pdfText }) {
    const truncatedOutcomes = outcomesJson.length > 30000
      ? outcomesJson.substring(0, 30000) + '\n... (省略)'
      : outcomesJson;
    return `${picoBlock}

【あなたの役割】
あなたはメタ分析データ抽出の **監査専門家** です。別のAIが抽出した outcomes リストを原論文と照合し、修正版を返してください。

【監査ポイント — 各項目を必ずチェック】
1. **数値の転記ミス**: evidenceText に書かれた数値が interventionGroup/comparisonGroup/effectEstimate に正しく入っているか
2. **空欄の補完**: 数値フィールドが "-" "不明" "" のままになっていて、原文に該当数値があれば必ず補完
3. **SD vs SE の混同**: "±" 表記、"(SE)" 表記の判別が正しいか。SE なら sdOrSe="SE" + notes に変換式を明記
4. **集団タイプの分離**: ITT/PP/mITT/Safety が混ざっていないか、populationType が正しいか
5. **時点違いの分離**: 同一アウトカムが複数時点で報告されている場合、別レコードになっているか
6. **見落としアウトカム**: 元のリストに含まれていない重要アウトカムが論文中に存在しないか
7. **figureType の妥当性**: KMカーブからの抽出なら "KaplanMeier"、表からなら "Table" を必ず記録
8. **evidenceText / evidenceTextJa**: 原文と日本語訳の整合性、両方とも 250 文字以内

【重要な出力ルール】
- correctedOutcomes には **元のリストを修正した完全版** を入れる（差分でなく全件）
- 元の項目を削除しない（修正のみ）
- 空欄に値が入れられた場合は notes に "[Critic修正]" と追記
- 新たに発見したアウトカムも correctedOutcomes に追加
- issuesFound に発見した問題を簡潔に箇条書き
- confidenceScore に総合信頼度（0-100）

【元の抽出結果】
${truncatedOutcomes}

【参照テキスト（原論文）】
${pdfText.substring(0, 40000)}`;
  }

  // 選択範囲（テキスト / 画像）から1個のアウトカムを抽出する system prompt
  function buildSelectionSystemPrompt({ type }) {
    return `あなたは医学RCT論文のメタ分析データ抽出専門家です。提供された論文の${type === 'text' ? '選択テキスト' : '選択画像'}から、**1個のアウトカム**を抽出してください。
JSON1個（配列でなく単一オブジェクト）だけを返答。マークダウン不要。
evidenceText には選択された原文（${type === 'image' ? '画像から読取り、' : ''}改変禁止、120文字以内に要約抜粋可）を、evidenceTextJa にその日本語訳を入れてください。
数値（n, 平均, SD, 効果量, P値）は必ず構造化フィールドに入れてください。

⚠⚠⚠ 最重要・他のすべてに優先（違反絶対禁止） ⚠⚠⚠

選択範囲に「(n=X, 数値) が 2 セット併記」されていれば、必ず両方を interventionGroup と comparisonGroup の両方に転記。片方を空のまま返すのは絶対禁止。

【内部思考プロセス（JSON 出力前に必ず実行）】
Step 1: テキスト/画像内のすべての「(n=数値)」をリストアップ
Step 2: 同じ outcome について 2 セットの (n, value) があるか確認
Step 3: 2 セット存在 → 1 セット目を interventionGroup、2 セット目を comparisonGroup に格納
Step 4: comparisonGroup.n_total と events_or_mean が両方とも非空か自己チェック
Step 5: 片方でも空なら Step 1 に戻ってやり直す

【⭐ ワーキング例 — この通りに処理する ⭐】
入力テキスト:
"Analyzed 5 years (n=115) Cumulative successes (n=96) Cumulative failures (n=19) Analyzed 5 years (n=114) Cumulative successes (n=75) Cumulative failures (n=39)"

Step 1 実行: 検出した (n=) → n=115, n=96, n=19, n=114, n=75, n=39 (合計6個)
Step 2 実行: outcome "Cumulative successes" について
   → セット1: (n=115, successes=96, failures=19)
   → セット2: (n=114, successes=75, failures=39)
   → 2 セット存在
Step 3 実行: → interventionGroup={n_total:"115", events_or_mean:"96"}, comparisonGroup={n_total:"114", events_or_mean:"75"}
Step 4 実行: 両方非空 ✓ → 出力 OK

✅ 正しい JSON 出力:
{
  "actualOutcomeName": "Cumulative successes",
  "timePoint": "5年",
  "variableType": "Binary",
  "interventionGroup": { "n_total":"115", "events_or_mean":"96", "sd_or_se":"-" },
  "comparisonGroup":   { "n_total":"114", "events_or_mean":"75", "sd_or_se":"-" }
}

❌ 間違った出力（絶対ダメ）:
{
  "interventionGroup": { "n_total":"115", "events_or_mean":"96" },
  "comparisonGroup":   { "n_total":"", "events_or_mean":"" }   ← 空のままは禁止！
}

【ラベルが同じでも 2 つあれば 2 群】
"Analyzed 5 years" のような同じラベルが 2 回並列している場合、それは「Flow diagram の左右ボックス」「2 つの治療アーム」を意味する。ラベルが同じでも n が違えば異なる 2 群。
"Group A/B" / "Intervention/Control" / "PCR/SW" / 表の 2 列 / 図の 2 ボックス なども同様に 2 群として処理。

【🎯 2群比較RCT専用ルール（絶対遵守）】
本アプリは2群比較RCT（介入群 vs 対照群）専用。3群以上は扱わない。
- **イベント数 / 症例数(N) / 平均値 / SD は必ず介入群と対照群の両方を抽出**（片方のみは厳禁）
- 選択範囲内に対照群が見えない場合: 画像/テキストの周辺、隣接する Box/Table/段落を必ず精査して両群の値を抽出する
- 例: 選択範囲に "Group A: n=115, success=96" のみ表示でも、画像/ページ内に "Group B: n=114, success=70" 等が併記されていれば**必ず両方を読み取る**
- どうしても周辺に対照群が無い場合のみ、notes に "[警告: 対照群データが選択範囲内に不在 — 周辺を要確認]" を明記し、interventionGroup に値を入れて comparisonGroup の n_total/events_or_mean/sd_or_se は "未抽出" にせず可能な限り推定または "不明" を入れる
- HR / RR / OR / MD など2群を統合した指標は単一値で記録可
- 3群試験でも、最も関連する2群比較に絞る（thirdGroup フィールドは使用しない）

【🔬 連続量の全パターン抽出（厳守）】
連続量で術前値・術後値・変化量・群間差が選択範囲または周辺に併記されている場合、**見つかった全パターンを区別**して抽出。本コールでは1個のアウトカムしか返せないため、**最も情報量の多いパターン（通常は変化量 or 群間差MD）を優先**し、他パターンが併記されていることを notes に明記:
- 例: "[術後値も併記: 介入群 25.3±12.1 / 対照群 38.7±14.5 (Table X)]"
- 例: "[術前値も併記: 介入群 38.5±11.2 / 対照群 39.1±10.8]"
- actualOutcomeName に必ずパターンを明記: "[術後値]" / "[変化量 post-pre]" / "[群間差MD]" / "[ANCOVA調整]" 等
- 利用者が後で別パターンを抽出できるよう、併記された値は必ず notes に転記する

【📖 数字の意味を必ず確認（脚注・凡例の精読）】
選択範囲または周辺画像内に脚注・凡例があれば必ず読む:
- "Data are mean ± SD/SE/SEM" → SD/SE/SEM の判別（SE/SEM なら SD = SE × √n に変換、notes に式記録）
- "Values are median (IQR)" → mean/SD と扱わない
- "based on available data" / "Safety population" → 分母が randomized でない
- "LS mean" / "adjusted for baseline" → ANCOVA調整値（群別 mean/SD と混ぜない）
- "Error bars indicate SEM/SD/95%CI" → エラーバーの種類確認
- "Higher scores indicate worse/better" → スケール方向（必要なら符号反転）
- "n=X" の分母単位（patients / teeth / lesions / cycles）を確認、ランダム化単位と違えば notes に "[分母単位: 〜]"
- KM曲線の "number at risk" はイベント数ではない（混同厳禁）

【鉄則】「どのアウトカム / どの時点 / どの解析集団（ITT/PP/safety等）/ どの分母 / どの統計量」を数字とセットで必ず記録。揃わない単独の数字は confidence="low" + notes に欠落項目を明記。`;
  }

  // 選択範囲のユーザープロンプト（textモード / imageモード）
  function buildSelectionUserPrompt({ type, text, pageNum }) {
    if (type === 'text') {
      return `【論文の選択箇所（${pageNum ? `P.${pageNum}` : 'ページ不明'}）】
${text}

【タスク】上記から1個のアウトカムを抽出。**介入群と対照群の両方**の数値を必ず埋める。
選択箇所に「(n=X, 数値)」が 2 セット併記されていれば、それは2群（intervention vs control）。
**フィールドを空のままにしない** — 不明なら "不明"、該当なしは "-" を記載。

以下の JSON 形式で返答（マークダウン不要、両群とも全フィールド埋める）:
{
  "actualOutcomeName": "アウトカム名（時点を含めると良い）",
  "timePoint": "時点（例: 5年, 24時間, 12週）",
  "variableType": "Binary | Continuous | TimeToEvent",
  "populationType": "ITT | mITT | PP | safety | 不明",
  "interventionGroup": { "n_total": "X", "events_or_mean": "Y", "sd_or_se": "Z または -" },
  "comparisonGroup":   { "n_total": "X", "events_or_mean": "Y", "sd_or_se": "Z または -" },
  "effectEstimate":    { "measureType": "RR/OR/HR/MD/SMD/-", "value": "...", "ci95": "...", "pValue": "..." },
  "evidenceText":      "選択原文をそのまま引用（120字以内）",
  "evidenceTextJa":    "日本語訳",
  "sourceLocation":    "選択範囲の出処",
  "pageNumber":        ${pageNum || 0},
  "confidence":        "high | medium | low",
  "notes":             ""
}

⚠ 出力直前の自己チェック（必須）:
✓ interventionGroup.n_total と events_or_mean が両方非空か?
✓ comparisonGroup.n_total と events_or_mean が両方非空か?（"未抽出" や 空文字列で出力するのは禁止。値が分からない場合のみ "不明" と記載）
✓ 選択箇所に2セットの数値が見えるなら、両群とも実際の数値で埋まっているか?`;
    }
    // image branch
    return `【論文画像（${pageNum ? `P.${pageNum}` : 'ページ不明'}）】の選択範囲から1個のアウトカムを抽出。
画像内の数値・表のセル・グラフ軸目盛り・KMカーブの値などを丁寧に読取り、構造化フィールドに転記してください。
画像に**2列の表 / 2つのボックス / 2本の棒グラフ / 2つの群ラベル**のように2群分の数値が併記されていれば、必ず両方を interventionGroup と comparisonGroup に転記。
**フィールドを空のままにしない** — 不明なら "不明"、該当なしは "-" を記載。

以下の JSON 形式で返答（マークダウン不要、両群とも全フィールド埋める）:
{
  "actualOutcomeName": "アウトカム名（時点を含めると良い）",
  "timePoint": "時点",
  "variableType": "Binary | Continuous | TimeToEvent",
  "populationType": "ITT | mITT | PP | safety | 不明",
  "interventionGroup": { "n_total": "X", "events_or_mean": "Y", "sd_or_se": "Z または -" },
  "comparisonGroup":   { "n_total": "X", "events_or_mean": "Y", "sd_or_se": "Z または -" },
  "effectEstimate":    { "measureType": "RR/OR/HR/MD/SMD/-", "value": "...", "ci95": "...", "pValue": "..." },
  "evidenceText":      "画像内の文字・数値を文字起こし（120字以内）",
  "evidenceTextJa":    "日本語訳",
  "sourceLocation":    "Figure X / Table Y 等",
  "pageNumber":        ${pageNum || 0},
  "confidence":        "medium または low（目視抽出のため）",
  "figureType":        "Table | BarChart | LineChart | KaplanMeier | ForestPlot | Boxplot | FlowDiagram",
  "notes":             ""
}

⚠ 出力直前の自己チェック（必須）:
✓ interventionGroup.n_total と events_or_mean が両方非空か?
✓ comparisonGroup.n_total と events_or_mean が両方非空か?（"未抽出" や 空文字列で出力するのは禁止。値が分からない場合のみ "不明" と記載）
✓ 画像に2群分の数値が見えるなら、両群とも実際の数値で埋まっているか?`;
  }

  // 選択範囲抽出後、対照群が空の場合に呼ぶ自動補完プロンプト
  function buildCompletionPrompt({ intervention, evidence }) {
    return `以下の根拠原文には、2 群（介入群と対照群）の数値が記載されています。
既に介入群: n=${intervention.n_total}, events/mean=${intervention.events_or_mean || '不明'} は抽出済み。
**対照群（comparisonGroup）の n_total と events_or_mean** を補完してください。

【根拠原文】
${evidence}

【ルール】
- 原文に 2 セットの (n=X) があるなら、介入群と異なる方を comparisonGroup として抽出
- 不明な値は "不明"、該当なしは "-" を記載（空欄禁止）
- フィールドを空のままにしない

以下の JSON 形式だけで返答（マークダウン不要）:
{
  "comparisonGroup": { "n_total": "...", "events_or_mean": "...", "sd_or_se": "..." },
  "effectEstimate": { "measureType": "...", "value": "...", "ci95": "...", "pValue": "..." }
}`;
  }

  // 既存アウトカムの数値再抽出（reVerifyOutcome 用）
  function buildReVerifyPrompt({ outcome, pdfText }) {
    return `あなたは医学RCT論文のメタ分析データ抽出専門家です。
以下の特定アウトカムについて、論文本文から**数値を完全に抽出**してください。

【対象アウトカム】
- 名称: ${outcome.actualOutcomeName}
- 時点: ${outcome.timePoint || '不明'}
- 集団: ${outcome.populationType || '不明'}
- 既に判明している根拠原文: "${outcome.evidenceText || '(なし)'}"

【あなたの仕事】
論文本文を再精読し、上記アウトカムの介入群/対照群の N、イベント数または平均、SD/SE、効果量(RR/OR/HR/MD等)、95%CI、P値を**全て抽出**してください。
根拠原文に既に含まれている数値は必ず転記。新たに見つかった数値も追加。
不明なものは "不明" と記載してください。

以下のJSON形式だけで返答（マークダウン不要）:
{
  "interventionGroup": { "n_total": "...", "events_or_mean": "...", "sd_or_se": "..." },
  "comparisonGroup":   { "n_total": "...", "events_or_mean": "...", "sd_or_se": "..." },
  "effectEstimate":    { "measureType": "...", "value": "...", "ci95": "...", "pValue": "..." },
  "evidenceText":      "原文を再引用（必要なら追加）",
  "evidenceTextJa":    "日本語訳",
  "notes":             "追加の注記（あれば）"
}

【参照テキスト】
${pdfText.substring(0, 30000)}`;
  }

  /* ============================================================
   * MAIN PIPELINE — 4ステージ抽出
   *   Stage1: PDF準備（テキスト + 画像）
   *   Stage2: 核心抽出（SLIM_EXTRACT_SCHEMA）
   *   Stage3: 補完抽出（baseline / consort / commentary）
   *   Stage4: Critic監査（数値の転記ミス・空欄の補完）
   * ============================================================ */
  async function runExtractionPipeline({ apiKeys, model, getModel, pdfFile, pico, outcomes, onProgress, onNotice }) {
    const { callGemini, makeKeyRotator, GEMINI_MODELS, extractPdfText, getPdfBase64, extractPdfImages } = ensureConfigured();

    const picoBlock = buildPicoBlock(pico, outcomes);

    const rotator = makeKeyRotator(apiKeys);
    if (rotator.size === 0) throw new Error("APIキーが設定されていません");

    // 各ステージで最新モデルを読み取れるようにする
    const liveModel = () => (getModel ? getModel() : null) || model;
    const initialModelInfo = GEMINI_MODELS.find(m => m.id === liveModel()) || GEMINI_MODELS[0];
    // PDF画像化判定は最初のモデルを基準（途中変更されてもStage1の挙動には影響しない）
    const isMultimodal = !initialModelInfo.textOnly;

    // Stage 1: PDF準備
    onProgress("stage1", isMultimodal ? "PDF準備中（テキスト + 高解像度画像）..." : "PDF準備中（テキスト抽出）...", 5);
    const tasks = [extractPdfText(pdfFile)];
    if (isMultimodal) {
      tasks.push(getPdfBase64(pdfFile));
      tasks.push(extractPdfImages(pdfFile, m => onProgress("stage1", m, 15), 3.5));
    }
    const taskResults = await Promise.all(tasks);
    const pdfText = taskResults[0];
    const pdfBase64 = isMultimodal ? taskResults[1] : null;
    const pdfImages = isMultimodal ? taskResults[2] : null;
    onProgress("stage1", isMultimodal ? `PDF準備完了 (${pdfImages.length}ページの高解像度画像)` : `PDF準備完了 (テキスト ${pdfText.length.toLocaleString()}文字)`, 25);

    const figurePrompt = buildFigurePrompt(isMultimodal);

    // 各ステージ実行時の最新モデルとそれに基づく挙動
    const stageModelInfo = (stage) => {
      const m = liveModel();
      const info = GEMINI_MODELS.find(x => x.id === m) || GEMINI_MODELS[0];
      if (m !== model) onNotice && onNotice(`🔄 ${stage}: モデル変更を反映 → ${info.name.replace(/\s*\(.+/, '')}`);
      return info;
    };

    // 出力長制約：モデルの出力上限に応じて引用文の最大長を変える
    // 出力上限が小さいモデル(<16K)では evidenceText を120文字に制限し、全アウトカムが入りきるよう調整
    const evidenceCap = (initialModelInfo.maxOut || 8192) < 16000 ? 120 : 250;

    const userPrompt = buildExtractionUserPrompt({ picoBlock, figurePrompt, evidenceCap, pdfText, isMultimodal });

    // === Stage 2: 核心抽出 ===
    const stage2Info = stageModelInfo("Stage2 核心抽出");
    onProgress("stage2", `${stage2Info.name.replace(/\s*\(.+/, '')} で核心抽出中...`, 35);

    let extracted;
    const stagesUsed = { core: stage2Info.id };  // フォールバック発生時は onModelUsed で上書きされる
    try {
      extracted = await callGemini({
        rotator, model: stage2Info.id,
        systemPrompt: SYSTEM_PROMPT_EXTRACT,
        userText: userPrompt,
        images: pdfImages,
        pdfBase64: pdfBase64,
        schema: SLIM_EXTRACT_SCHEMA_GEMINI,
        thinkingBudget: stage2Info.thinking ? 4000 : 0,
        onNotice: (m) => { onProgress("stage2", m, 50); onNotice && onNotice(m); },
        onModelUsed: (actualModel) => { stagesUsed.core = actualModel; }
      });
    } catch (e) {
      throw new Error(`抽出に失敗しました: ${e.message}\n\n💡 ヒント:\n・Flash Lite なら出力64K で安定、Flash は思考モードで精度向上\n・1論文 = 3 リクエスト消費。連投で RPD 20/日を超えると失敗するので 5論文/日 以内に\n・複数キー登録で 429/503 を回避（別プロジェクトのキーで枠が掛け算）`);
    }

    // === Stage 3: 補完抽出 ===（最新モデルで実行 — 抽出中の手動切替に追従）
    const stage3Info = stageModelInfo("Stage3 補完抽出");
    stagesUsed.supplement = stage3Info.id;
    onProgress("stage3", `${stage3Info.name.replace(/\s*\(.+/, '')} で患者背景・解説を取得中（失敗してもOK）...`, 60);
    try {
      const supplementPrompt = buildSupplementPrompt({ picoBlock, pdfText });

      const supplement = await callGemini({
        rotator, model: stage3Info.id,
        systemPrompt: SYSTEM_PROMPT_EXTRACT,
        userText: supplementPrompt,
        images: null, pdfBase64: null,
        schema: SUPPLEMENT_SCHEMA_GEMINI,
        thinkingBudget: 0,
        onNotice: (m) => { onProgress("stage3", m, 70); onNotice && onNotice(m); },
        onModelUsed: (actualModel) => { stagesUsed.supplement = actualModel; }
      });
      if (supplement) {
        if (supplement.consortFlow) extracted.consortFlow = supplement.consortFlow;
        if (supplement.baselineCharacteristics) extracted.baselineCharacteristics = supplement.baselineCharacteristics;
        if (supplement.expertCommentary) extracted.expertCommentary = supplement.expertCommentary;
        if (supplement.paperQualityAssessment) extracted.paperQualityAssessment = supplement.paperQualityAssessment;
      }
    } catch (e) {
      console.warn("補完抽出失敗（核心データは取得済みなので継続）:", e);
      extracted._supplementError = e.message;
    }

    // === Stage 4: Critic 監査パス ===（最新モデルで実行 — Flash切替で精度向上を期待できる）
    if (extracted.extractedOutcomes && extracted.extractedOutcomes.length > 0) {
      const stage4Info = stageModelInfo("Stage4 Critic監査");
      stagesUsed.critic = stage4Info.id;
      onProgress("stage4", `${stage4Info.name.replace(/\s*\(.+/, '')} で Critic 監査中...`, 80);
      try {
        const outcomesJson = JSON.stringify(extracted.extractedOutcomes, null, 2);
        const criticPrompt = buildCriticPrompt({ picoBlock, outcomesJson, pdfText });

        // ★ Critic はテキスト主体（images/PDF を送らない）→ TPM 大幅節約
        // outcomes JSON + pdfText だけで十分。画像はStage2で活用済み
        const review = await callGemini({
          rotator, model: stage4Info.id,
          systemPrompt: CRITIC_PIPELINE_SYSTEM_PROMPT,
          userText: criticPrompt,
          images: null,    // ← Stage2で画像は処理済みなので Critic では送らない（TPM節約）
          pdfBase64: null, // ← 同上
          schema: CRITIC_REVIEW_SCHEMA_GEMINI,
          thinkingBudget: stage4Info.thinking ? 8000 : 0,
          onNotice: (m) => { onProgress("stage4", m, 90); onNotice && onNotice(m); },
          onModelUsed: (actualModel) => { stagesUsed.critic = actualModel; }
        });

        if (review && Array.isArray(review.correctedOutcomes) && review.correctedOutcomes.length > 0) {
          extracted.extractedOutcomes = review.correctedOutcomes;
          extracted._criticConfidence = review.confidenceScore;
          extracted._criticAssessment = review.overallAssessment;
          extracted._criticIssues = review.issuesFound || [];
          extracted._criticAddedOutcomes = review.addedOutcomes || [];
        }
      } catch (e) {
        console.warn("Critic監査失敗（オリジナルの outcomes を保持）:", e);
        extracted._criticError = e.message;
      }
    }

    // どのステージで何のモデルが使われたかを表示
    const allSame = stagesUsed.core === stagesUsed.supplement && stagesUsed.core === stagesUsed.critic;
    extracted._sources = allSame
      ? [`${GEMINI_MODELS.find(m => m.id === stagesUsed.core)?.name || stagesUsed.core} [3パス精度最大化]`]
      : [`核心: ${stagesUsed.core} / 補完: ${stagesUsed.supplement || '-'} / Critic: ${stagesUsed.critic || '-'}`];
    extracted._stagesUsed = stagesUsed;
    onProgress("complete", "抽出完了", 100);
    return extracted;
  }

  /* ============================================================
   * EXPORT
   * ============================================================ */
  global.ExtractionAlgorithm = {
    version: VERSION,
    configure,

    // システムプロンプト（フル版）
    SYSTEM_PROMPT_EXTRACT,
    SYSTEM_PROMPT_CRITIC,
    SYSTEM_PROMPT_VERIFY,
    CRITIC_PIPELINE_SYSTEM_PROMPT,
    NUMERIC_FOCUSED_SYSTEM_PROMPT,

    // スキーマ（JSON + Gemini版）
    EXTRACT_SCHEMA_JSON, EXTRACT_SCHEMA_GEMINI,
    SLIM_EXTRACT_SCHEMA_JSON, SLIM_EXTRACT_SCHEMA_GEMINI,
    SUPPLEMENT_SCHEMA_JSON, SUPPLEMENT_SCHEMA_GEMINI,
    SINGLE_OUTCOME_SCHEMA_JSON, SINGLE_OUTCOME_SCHEMA_GEMINI,
    CRITIC_REVIEW_SCHEMA_JSON, CRITIC_REVIEW_SCHEMA_GEMINI,
    CRITIC_SCHEMA,
    toGeminiSchema,

    // プロンプトビルダー
    buildPicoBlock,
    buildFigurePrompt,
    buildExtractionUserPrompt,
    buildSupplementPrompt,
    buildCriticPrompt,
    buildSelectionSystemPrompt,
    buildSelectionUserPrompt,
    buildCompletionPrompt,
    buildReVerifyPrompt,

    // パイプライン
    runExtractionPipeline,
  };
})(typeof window !== 'undefined' ? window : globalThis);
