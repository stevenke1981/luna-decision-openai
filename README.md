# luna-decision-openai — 單一 GPT 模型，OpenAI Luna 決定每一步的 effort，長任務不亂停

> 只跑一個主模型（預設 GPT-6.1 Terra），每次 generation 的 reasoning effort（`low`～`max`）由 OpenAI 的 **`gpt-6-luna`** 決定；模型話說到一半就收工時，proxy 會把任務接回來做完。

本專案是本機 proxy（預設 `http://127.0.0.1:8791/v1`），供 Codex、opencode、aider 等客戶端使用。它只執行一個主模型：預設 `gpt-6.1-terra`，可改選 `gpt-6.1-sol` 或 `gpt-6-astra`。每次 generation 送出前，proxy 透過 OpenAI [Decisions API](https://developers.openai.com/api/docs/guides/decisions) 呼叫 `gpt-6-luna`，決定這一步要用哪一級 reasoning effort（預設階梯 `low`、`medium`、`high`、`xhigh`、`max`）。Luna 的呼叫費用計入你的 OpenAI API 金鑰。Luna 棄權、逾時或失敗時改由本地規則決定，而且規則同時把關 Luna 的結果。

本專案衍生自 laya-gpt。預設埠 8791 與 Codex profile `luna-decision` 讓它可以和 laya-gpt（8790）同時執行。

## Quick start

```powershell
# Windows PowerShell, in the repository folder
npm link                                    # required once: registers the luna-decision-openai command
luna-decision-openai --version
$env:OPENAI_API_KEY = "sk-..."              # the key Luna calls are billed to (this window only; or use .env.local, see API keys)
luna-decision-openai probe                  # one live gpt-6-luna call: checks the key and the call shape
luna-decision-openai install                # writes $CODEX_HOME\luna-decision.config.toml (default ~\.codex)
luna-decision-openai codex                  # starts the proxy in the background if needed, then runs: codex -p luna-decision
```

```bash
# bash, in the repository folder
npm link
export OPENAI_API_KEY=sk-...
luna-decision-openai probe
luna-decision-openai install
luna-decision-openai codex
```

Keys can also live in `.env.local` (copy `.env.example`), or in a system environment variable that survives new terminals; see [API keys / 金鑰設定](#api-keys--金鑰設定).

Other clients (opencode, aider, crush) and the live view of decisions:

```text
luna-decision-openai serve        # foreground proxy; prints every decision
base URL  http://127.0.0.1:8791/v1
model     luna-auto               # or: auto
```

Choosing the main model: `luna-decision-openai install --model gpt-6.1-sol` (profile), `luna-decision-openai codex --model gpt-6-astra` (this run), or `LUNA_MODEL=gpt-6.1-sol` for `serve`.

If `npm link` was run but the command is not found, reopen the terminal. You can also run the CLI directly with `node bin\luna.js <command>`.

## 快速開始

1. 安裝 Node.js ≥ 22.15 與 Codex CLI（`npm i -g @openai/codex`）。
2. 在專案資料夾執行 `npm link`，註冊 `luna-decision-openai` 指令（必做一次）。
3. 設定金鑰（見下節「API keys／金鑰設定」）：系統環境變數、專案的 `.env.local`，或 `~/.luna-decision-openai/.env.local`。只想對目前視窗生效時，PowerShell 用 `$env:OPENAI_API_KEY = "sk-..."`，bash 用 `export OPENAI_API_KEY=sk-...`。
4. `luna-decision-openai probe`：實際呼叫一次 `gpt-6-luna`，確認金鑰與呼叫形狀。
5. `luna-decision-openai install`，然後 `luna-decision-openai codex`（自動啟動 proxy 並以 `codex -p luna-decision` 開啟 Codex）。
6. 要換主模型：`luna-decision-openai codex --model gpt-6.1-sol`。其他客戶端請把 base URL 設為 `http://127.0.0.1:8791/v1`、model 設為 `luna-auto`。

## 安裝需求

- Node.js ≥ 22.15。`package.json` 沒有 dependencies，不需要 `npm install`。
- Codex CLI。在 Windows 上，`codex` 子指令要找 npm 安裝的版本（`codex.cmd` 與 `@openai/codex`）；找不到時會提示改用 `serve` 再執行 `codex -p luna-decision`。
- OpenAI API 金鑰（`OPENAI_API_KEY` 或 `LUNA_API_KEY`）為選用。預設 `LUNA_MODE=auto`：有金鑰就由 Luna 決定，沒有就自動改用本地規則（`heuristic`），不必改設定。

## API keys / 金鑰設定

### 三種金鑰

| 變數 | 用途 | 必要性 |
|---|---|---|
| `OPENAI_API_KEY` | 每次 Luna 決策的費用（Decisions API，`gpt-6-luna`，依決策計費）。`install --provider openai` 時也是主模型的金鑰 | Luna 需要；沒有時 effort 由規則決定 |
| `OPENROUTER_API_KEY` | `install --provider openrouter` 時，主模型經 OpenRouter 的金鑰（`sk-or-`） | 只有選 openrouter 時需要。**Luna 仍需 `OPENAI_API_KEY`**，因為 OpenRouter 金鑰不能呼叫 Decisions API |
| `LUNA_API_KEY` | 只給 Luna 用的獨立金鑰，優先於 `OPENAI_API_KEY` | 選用 |

### 主模型的登入方式（`install --provider` 或 `LUNA_PROVIDER`，預設 `chatgpt`）

| provider | Codex profile 寫入 | 主模型去向 |
|---|---|---|
| `chatgpt` | `requires_openai_auth = true`（沿用 Codex 的 ChatGPT 登入） | ChatGPT 後端 |
| `openai` | `env_key = "OPENAI_API_KEY"` | Codex 送出 `sk-` 金鑰，proxy 轉到 `api.openai.com` |
| `openrouter` | `env_key = "OPENROUTER_API_KEY"` | Codex 送出 `sk-or-` 金鑰，proxy 轉到 OpenRouter，模型 id 改為 `openai/<id>` |

proxy 依客戶端送出的金鑰選上游（`src/proxy.js` 的 `upstreamBase`）。`openai` 與 `openrouter` 時，Codex 讀取 `env_key` 指定的環境變數。不論哪種 provider，Luna 的決策金鑰都由 `LUNA_API_KEY` 或 `OPENAI_API_KEY` 決定。`serve` 在 provider 為 `openrouter` 且未設定 `OPENROUTER_API_KEY` 時會提示。

### 三種設定方式

1. **系統環境變數**（Windows，持久）：
   ```powershell
   [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', 'sk-...', 'User')
   ```
   設定後要開新的終端機才讀得到。bash 則用 `export OPENAI_API_KEY=sk-...`，寫入 shell 設定檔才會持久。
2. **專案的 `.env.local`**：
   ```powershell
   Copy-Item .env.example .env.local   # then edit the file
   ```
   ```bash
   cp .env.example .env.local
   ```
3. **全域安裝（npm link）的 `~/.luna-decision-openai/.env.local`**（`LUNA_HOME` 可改位置）。

### 優先順序

1. 已設定的系統或 shell 環境變數（非空字串）永遠優先，檔案不會覆蓋它。
2. 專案資料夾的 `.env.local`，再 `.env`。
3. `LUNA_HOME`（預設 `~/.luna-decision-openai`）的 `.env.local`，再 `.env`。

同一變數先找到者勝出。只讀取 `LUNA_*`、`OPENAI_*`、`OPENROUTER_*` 變數，共用 `.env` 裡的其他秘密不會傳給 `codex` 與它執行的工具。檔案開頭的 UTF-8 BOM 會被忽略；檔案存在但讀不到時只顯示警告。`serve` 啟動時會列出載入了哪些檔案與變數名稱（不印出值）。命令列的 `--model`／`--effort`／`--provider` 優先於以上全部。

注意：

- `.env.local` 與 `.env` 已列入 `.gitignore`，**不要 commit 它們**。`.env.example` 是可提交的範本。
- Codex 桌面版與 IDE 擴充（`install --global`）只讀系統環境變數，不讀 `.env.local`。provider 是 `openai` 或 `openrouter` 時，請把對應金鑰設為系統環境變數，否則 Codex 讀不到 `env_key`。provider 是 `chatgpt` 時不受影響。

## 工作方式

### 運作模式（`LUNA_MODE`）

共有 **5 種**模式，預設 `auto`。模式決定兩件事：每次 generation 的 effort 由誰決定，以及收工時由誰判斷「是否還沒做完」。

| 模式 | effort 由誰決定 | 收工判斷 | 需要的金鑰／額外費用 | 計畫提醒、續跑、驗證關卡、自我審查 |
|---|---|---|---|---|
| `auto`（預設） | **每個請求各自判斷**：有 Luna 可用的金鑰就照 `luna` 模式；沒有就照 `LUNA_AUTO_FALLBACK`（預設 `heuristic`，可設 `llm`）。「有金鑰」指 `LUNA_API_KEY`、`OPENAI_API_KEY`，或客戶端自己送的 OpenAI 金鑰（條件同下節「Luna 用哪把金鑰」） | 同所選模式：`luna` 時由 Luna 判斷加規則把關，否則只用規則 | 有金鑰時同 `luna`；沒有金鑰時同 fallback（`heuristic` 免費） | 全部啟用 |
| `luna` | OpenAI `gpt-6-luna`（Decisions API）。新 turn 由 Luna 決定；turn 中 Luna 只能調高，本地規則為下限 | Luna 讀收尾文字，規則把關（驗證關卡、計畫未完成等規則分數較高時以規則為準） | `OPENAI_API_KEY` 或 `LUNA_API_KEY`；每次決策約 $0.00015 以內。沒有金鑰、Luna 棄權（信心低於 `LUNA_MIN_CONFIDENCE`）或呼叫失敗時自動改用規則 | 全部啟用 |
| `heuristic` | 只用本地規則（見下方「規則」） | 只用規則 | 不需要金鑰，不呼叫 Luna，沒有額外費用 | 全部啟用 |
| `llm` | 以 `LUNA_JUDGE_MODEL`（未設定時用主模型）當判官，effort 為 `LUNA_JUDGE_EFFORT`（預設 `low`），逾時 `LUNA_JUDGE_TIMEOUT_MS`。只在 Responses 的第 2 步起使用；新 turn 的第一步、Chat Completions、判官失敗時用規則 | 只用規則 | 判官請求送往主模型的同一上游、使用客戶端的憑證，計入主模型帳單 | 全部啟用 |
| `off` | 不改 effort，客戶端送什麼就用什麼；只把 `luna-auto` 等別名改成 `LUNA_MODEL` | 不判斷 | 無 | 全部停用（純轉送） |

選擇建議：
- 一般使用：維持預設 `auto`。設定 `OPENAI_API_KEY` 就用 Luna，沒設定就用規則，兩種情況都不必改模式。
- 有金鑰但仍想固定使用 Luna（例如要確認沒金鑰時會出錯，而不是默默改用規則）：`luna`。在此模式下沒金鑰時每次決策都會嘗試 Luna 再失敗退回，記錄中標示 `heuristic (luna failed: …)`。
- 有金鑰卻不想把需求文字送到 OpenAI，或想要零額外費用：`heuristic`。長任務續跑、驗證與自審照常運作。
- 沒有金鑰時想改用判官模型而不是規則：`LUNA_AUTO_FALLBACK=llm`（維持 `auto`）。
- 想用自己指定的模型判斷 effort：`llm`（實驗性質，判官會花主模型的額度）。
- 只想用別名、完全不介入：`off`。

設定方式（與其他變數相同，系統環境變數優先於 `.env.local`）：

```powershell
# 只對這個視窗有效
$env:LUNA_MODE = "heuristic"
luna-decision-openai stop        # 已在背景執行的 proxy 要先停掉，新模式才會生效
luna-decision-openai codex       # 背景啟動的 proxy 會沿用這個視窗的環境變數
```

```ini
# 或寫進 .env.local（專案資料夾或 ~/.luna-decision-openai/）
LUNA_MODE=heuristic
```

確認目前模式：`serve` 啟動列的 `mode=…`（`auto` 時顯示 `auto→luna` 或 `auto→heuristic`，依是否設定了金鑰；沒有金鑰時另印一行說明客戶端自帶 OpenAI 金鑰仍會啟用 Luna），或 `/luna/health` 回傳的 `mode`（`auto` 時另有 `autoFallback`）。每筆決策的 `source` 欄位顯示實際由誰決定，例如 `luna`、`heuristic (luna considered)`、`heuristic (luna failed: …)`、`judge`、`model only`。

### Effort 如何決定

proxy 位於客戶端與上游之間。每次 generation 前，它讀取本輪的軌跡並向 Luna 提問。

| 時機 | Luna 收到的 state | 問題 | 把關 |
|---|---|---|---|
| 新 turn（使用者送出新訊息） | `{"request": "<需求前 2000 字>"}` | `effort`：`score` 題，階梯每一級附一句說明（low＝小問題或單一小改，medium＝一般程式工作，high＝設計、跨模組重構、根因，xhigh＝架構、安全、並行，max＝最困難） | Luna 直接決定；棄權或失敗才用規則 |
| turn 中（第 2 步起，每次 generation 前） | `last_step`（一句話）、`recent_steps`（最近 8 步的 kind、command 前 160 字、status）、`steps_so_far`、`request` | `effort`（同上階梯）與 `stuck`（`predicate`：是否反覆失敗或重複同一失敗動作） | Luna 只能調高：Luna 的 effort 高於規則才採用，否則沿用規則並把 Luna 的理由附在後面 |

Luna 的 effort 答案取 `LUNA_EFFORT_QUANTILE`（預設 0.5，即中位數）所在的級。信心（`confidence`，缺少時取最高機率）低於 `LUNA_MIN_CONFIDENCE`（預設 0.4）就棄權，改用規則。在 turn 中，若 Luna 勝出，保持時間（hold）為 `stuck` 機率決定的值（≥ 0.75 保持 2 個 generation，≥ 0.5 保持 1 個，< 0.25 立即解除）與規則的 hold 取較大者，因此失敗中的 agent 不會被 Luna 提早降級。

`last_step` 不是原始輸出，而是由程式把工具結果轉成固定片語（例如 `ran the tests or build, it failed; 2 failures in a row; the same failing command was repeated`），相同情境問相同問題。

### 規則（Luna 棄權或失敗時使用；turn 中也是下限）

以下括號為預設階梯 `low,medium,high,xhigh,max` 下的級別：

新 turn：
- 招呼或致謝（hi、thanks、你好、謝謝 等）→ 最低級（low）。
- 超過 600 字，或含 design、refactor、race、security、why、debug、設計、重構、除錯、為什麼 等詞，或問「如何運作、比較、分析」→ 預設再高一級（high）。
- 其餘 → 預設級（medium，`LUNA_DEFAULT_EFFORT`）。

turn 中：
- 連續 3 次以上失敗，或最近 6 步內失敗指令重複出現 2 次以上（且最後一步仍失敗）→ 最高級（max），保持 2 個 generation。
- 連續 2 次失敗 → 第三級（high），保持 2 個。
- 剛失敗 1 次 → 中間級（medium），保持 1 個。
- 最近從數次失敗中恢復 → medium，並可立即解除保持。
- 剛改過程式（edit），或距上次 edit 已讀了 ≥ 4 個檔案 → medium。
- 其他例行步驟（讀檔、搜尋、成功的指令）→ 最低級（low）。

### 升降級（hysteresis）

- 升級立即生效。
- 降級每個 generation 最多降一級，且先依 hold 保持。
- 同一 turn 續跑過之後，effort 不低於 `LUNA_DEFAULT_EFFORT`。
- 同一 session 的狀態依請求的 `prompt_cache_key` 保存，沒有時依 `session_id`、`conversation_id` 標頭；新 turn 會重設。

### 為什麼針對 Luna 最佳化

這些設計寫在 `src/decisions.js` 的檔頭註解與常數中：

- **score＋分位數**：effort 是 `score` 題，階梯每一級是有序選項。Luna 回傳整個機率分布，proxy 取分位數而不是 argmax，所以能尊重級別的順序，Luna 不確定時也不會跳到不相鄰的級。
- **predicate 表示是非題**：`stuck`（turn 中）與 `in_progress`（收工判斷）各只有一個機率。
- **狀態用 `input_json`**：只傳結構化的 JSON，不傳整段對話；每次呼叫只有這份 JSON 不同。
- **共用 rubric 與快取**：rubric 有 5,531 個字元（估計約 1.3k tokens，以約 4 字元／token 估算；確切值以 `probe` 輸出為準），每次呼叫都相同，放在最前面，並且以 explicit cache breakpoint 與 `prompt_cache_key`（`luna-decision-openai/v1`）標記，因此前綴可快取。rubric 需超過 1,024 tokens 才會被快取，目前估計高於此門檻。快取命中率尚未在本次實測。
- **價格**：依官方指南，未快取輸入為 $0.10／1M tokens，輸出免費（`src/decisions.js` 的 `USD_PER_INPUT_TOKEN`）。估計每次決策約 1.3k 輸入 tokens，以未快取價計算，單次上限約 $0.00013。
- **費用上限**：`luna-decision-openai stats` 會把所有決策的輸入 tokens 以未快取價加總，輸出 `Luna decisions cost at most $…`。這是上限，不是實際帳單。

每個 routed generation 都會有一次 Luna 呼叫，所以費用隨 generation 數成長。同步等待也會增加延遲：每次 generation 前最多等 `LUNA_DECISION_TIMEOUT_MS`（預設 3000 ms）。

## 長任務協助：不讓 GPT-6.1 Terra 亂停

主模型在長任務中常提早結束 turn：寫一段摘要、說「接下來我會…」、或問「要我繼續嗎？」，但工作其實沒做完；或改了程式卻沒跑測試就說完成。本專案有四個機制處理這件事：計畫提醒、提早收工自動續跑、驗證關卡、自我審查。後三者在同一條串流內接續，Codex 只看到一個持續工作的 turn。

### 1. 計畫提醒（nudge，`LUNA_NUDGE=on`）

本輪計畫（Codex 的 `update_plan`；Chat 另讀 `todowrite`／`TodoWrite`）還有未完成步驟時，proxy 在每次 generation 前於請求末端附加提醒：已完成幾步、還剩哪些、全部完成並驗證前不要收工、不要停下來問是否繼續。Responses 以 developer 訊息附加，Chat 以 system 訊息附加。

### 2. 提早收工自動續跑（resume，`LUNA_CONTINUE=on`）

只適用於串流的 Responses 請求（Codex）。Chat Completions 不續跑。

proxy 會暫扣上游的 `response.completed`。若同時符合以下條件，就立即帶著原請求、剛才的輸出與一則 `[luna]` 提醒再送一次，新事件接在同一條串流上送回客戶端，客戶端只看到一個完整 turn：

- 這一代沒有需要客戶端執行的工具呼叫（即要把控制權交還使用者）；
- 本輪做過事，或有計畫；
- 本輪續跑總次數未達 `LUNA_MAX_CONTINUES`（預設 20）；
- 自上次有進展的續跑以來，「無進展」的續跑未超過 `LUNA_MAX_STALLS`（預設 2，見下）；
- `unfinished` ≥ `LUNA_CONTINUE_THRESHOLD`（預設 0.6）。

續跑的那一代 effort 提高一級（至少為預設值）。

**進展與停滯**：每次續跑時記下本輪的進展標記（`progressOf`：成功套用的程式編輯數、文件編輯數、計畫完成步數、程式的驗證狀態）。重跑已通過的測試、`git commit`、被拒的 patch 都不改變標記。下次續跑時標記沒變，就算一次「無進展」；標記一變就歸零。因此持續在做事的長任務可以一路續跑到總上限，只會說話不動手的 agent 在第 1 次續跑之後最多再被接回 `LUNA_MAX_STALLS` 次（`0`：只在有進展後才續跑）。無進展的續跑，提醒會加上「你又停了而且沒有進展，現在就用工具做下一步；真的卡住就明說需要使用者提供什麼」。

**焦點提醒**：續跑或審查的 `[luna]` 指令只隨那一代送出，客戶端不會保存。模型接著呼叫工具、Codex 帶著工具結果再送下一個請求時，proxy 會在請求末端（與計畫提醒合併為同一則 developer 訊息）重申一句短提醒：續跑時「你是因為任務未完成而被接回，做完並驗證前不要停」；審查時「你在自我審查輪，檢查完、修正、驗證後以簡短摘要結束」。turn 真正結束（不再續跑）或新 turn 開始時清除。

**續跑提醒的內容**（`continueText`）：未完成的原因、計畫進度與未完成步驟；最後一步失敗時引用該指令（前 160 字），要求先找根因、不要原樣重跑；程式改了沒驗證或測試仍失敗時，要求跑測試／建置／linter 並修到通過。

### 3. 驗證關卡（`LUNA_VERIFY=on`）

收工判斷的規則多兩條（排在徵求許可／承諾之後、「最後一步失敗」之前）：

- 最後一次修改程式之後，最近一次測試或建置（`verify` 類指令，如 `npm test`、`pytest`、`cargo test`）失敗 → 0.7（`tests or build still fail after the last edit`）；
- 修改程式之後沒有任何成功的檢查 → 0.65（`changed code without verifying it`）。其他成功執行的指令（`exec` 類，例如執行程式本身）也算檢查，避免沒有測試的專案被一直要求驗證；但版本控制（`git …`）、檔案搬移／刪除（`mkdir`、`cp`、`mv`、`rm` 等）與安裝（`npm install`、`pip install` 等）不算。被拒的 patch（工具結果失敗）不算修改。

只改文件（`.md`、`.mdx`、`.markdown`、`.rst`、`.adoc`、`LICENSE`、`CHANGELOG` 等；檔名取自 `apply_patch` 的 `*** Add/Update/Delete File:` 與 `*** Move to:` 行，支援 Windows 反斜線路徑，或 `path` 參數）不需要驗證。`.txt` 不算文件，因為 `requirements.txt`、`CMakeLists.txt` 是建置輸入。兩條都高於預設門檻，因此「改完沒測就說完成」或「測試還紅就收工」會被接回去修。Luna 模式下這兩條同樣把關 Luna 的判斷；只有 Luna 判定 `needs_user` 時不續跑。`LUNA_VERIFY=off` 回到只看文字的規則。

### 4. 自我審查（self-review，`LUNA_REVIEW_ROUNDS`，預設 1）

收工判斷認為已完成（低於門檻）、不是在等使用者（沒有索取金鑰等，Luna 未判 `needs_user`，收尾最後一行也不是問句）、且本輪改過程式（自上次審查後有新的程式編輯；只改文件不算）時，proxy 再送一輪 `[luna] Self-review.`：重讀原始需求、檢查每一項是否完成；看自己的變更（例如 `git diff`）找 bug、漏掉的邊界情況、錯誤處理與殘留的除錯碼；確認測試涵蓋並執行測試；發現問題就修並重新驗證，沒有問題就以一句話說明自審無問題後收工。審查輪計入 `LUNA_MAX_CONTINUES`，不受停滯計數限制；`LUNA_REVIEW_ROUNDS=2` 時，只有上一輪審查後又改了程式才會再審。`0` 關閉。終端機顯示為 `REVIEW #n`，紀錄中 `continues[].kind` 為 `review`。

自我審查讓模型「找出問題、修正問題」後才交還控制權：審查輪若修改程式，驗證關卡會再確保修改經過測試；全部通過後才真正結束 turn。

**收工判斷（`lunaStopCheck`）**：

1. 硬規則先決，不問 Luna：沒有任何工作 → 0；計畫仍有未完成步驟 → 0.9；收尾向使用者索取只有他能給的東西（金鑰、密碼、請提供、請先登入 等）→ 0.1。
2. 否則把收尾文字末 800 字，加上請求與步數，送給 Luna 一次，同時問兩題：
   - `end`（choice）：`will_continue`（打算或提議繼續）、`done`（說任務完成）、`needs_user`（需要使用者的金鑰、密碼、登入或決定）、`other`。
   - `in_progress`（predicate）：部分完成、還有剩。
3. 合併：`end` 為 `needs_user` → `unfinished` = P(will_continue)。其他情況 → max(P(will_continue), P(in_progress), 規則分數)。例外：`end` 為 `done` 且機率 ≥ 0.9 時，不採計 `in_progress`。
4. 規則分數：徵求許可的問句（would you like me to…?、要我…嗎？）或第一人稱承諾（next I'll、I will fix…、接下來我會、我會再修…）為 0.75；驗證關卡（見下）為 0.7／0.65；最後一步失敗為 0.5；其餘為 0.1。「if you want, I'll add docs」這類條件式提議不算承諾。

Luna 失敗時只用規則。`LUNA_MODE=heuristic` 或 `llm`，以及 `auto` 在沒有金鑰的請求，也只用規則；`LUNA_MODE=off` 不續跑。

## 專家角色：讓 Luna 選擇由哪一個 agent 來做（`LUNA_ROLE_PACK`）

設定一個或多個「專家包」後，每個新 turn 由 Luna 從包內的專家中挑一位最適合的，proxy 再把這位專家的工作方式交給主模型，整個 turn 都適用。這個問題附在原本的 effort 決策呼叫中一起問，不會多一次 API 請求。

支援兩種包，zip 或解壓後的資料夾都可以：

| 包的種類 | 辨識方式 | 每位專家 | 交給主模型的內容 |
|---|---|---|---|
| 團隊工作包（如 `agent-team-workflow`） | 有 `config/registry.json` | registry 中的一個職位（role） | 職位名稱、工作方法、操作步驟、交付物、完成條件 |
| 技能包（如 `storage-skills-pack`） | 一個或多個 `*/SKILL.md` | 每個 `SKILL.md`（取 front matter 的 `name`、`description`） | 技能說明與 `SKILL.md` 內文（前 1,500 字） |

zip 支援一般的 stored／deflated 格式（含檔尾註解、data descriptor）；zip64 不支援，請解壓後指定資料夾。解壓後單一檔案超過 8 MB 的包會被拒絕。`SKILL.md` 的 front matter 可以有 UTF-8 BOM、CRLF、跨行或 `|`／`>` 區塊寫法的 `description`。

可以同時載入多個包，例如軟體研發加上日後的遊戲開發、影片製作、音樂製作包，所有專家合併成一份清單由 Luna 挑選。新增領域只要把包加進 `LUNA_ROLE_PACK`，不需改程式。

```ini
# .env.local（以 ; 分隔多個包；可在包後加 |組合 指定職位組合）
LUNA_ROLE_PACK=E:\install_skills\agent-team-workflow.zip;E:\install_skills\storage-skills-pack-v1.0.zip
# 日後例：…;E:\packs\game-dev-pack.zip;E:\packs\av-team-workflow.zip|shorts
```

**開關**：專家功能可以隨時開關，不必移除 `LUNA_ROLE_PACK`。
- 啟動時的狀態由 `LUNA_ROLES=on|off`（預設 `on`）決定；`off` 時包照樣載入，只是不使用。
- 執行中切換：`luna-decision-openai roles off`、`luna-decision-openai roles on`，立即生效、不需重啟，效力維持到 proxy 重啟為止（重啟後回到 `LUNA_ROLES`）。底層是 `POST /luna/roles`，內容為 `{"enabled": true|false}`；`GET /luna/roles` 與 `/luna/health`（`rolesEnabled`）可查目前狀態。
- 關閉時：不問 Luna 專家題目（決策輸入回到約 1.45k tokens）、不跑關鍵字規則、不加專家訊息；turn 進行中關閉，該 turn 之後的生成也不再帶專家訊息。重新開啟後，新 turn 才會再挑選。
- `serve` 啟動時顯示 `roles=13 (off)` 表示已載入但關閉。

組合用 `|` 分隔而不用 `#`：`.env` 會把 `#` 之後當成註解，而且路徑本身可能含 `#`（例如 `C#`）。

**挑選的範圍**（`LUNA_ROLE_SET`，或每個包後面的 `|組合`）：
- 團隊包：預設取 `product` profile 中的實作職位（`mode` 為 `author`），`agent-team-workflow` 為 13 位。可改成其他 profile 名稱（如 `lean`、`full`；若該 profile 沒有實作職位，則取其全部職位）、`author`（所有實作職位，26 位），或逗號分隔的職位 id。
- 技能包：全部技能。
- 共用的 `LUNA_ROLE_SET` 為 profile 名稱時，不適用的包（例如技能包沒有 `product`）改用該包預設；為逗號分隔的 id 時，各包只取清單中有的 id，任何一個 id 在所有包中都找不到則報錯。寫在包後面的 `|組合` 必須適用該包，否則報錯。
- 相同 id（不同包之間或同一包內）以先出現的為準；名為 `none` 的專家會被略過，因為 `none` 保留給「不指派」。
- 包讀取失敗（檔案不見、格式錯誤、組合不適用）時，`serve` 印出警告並在沒有專家的情況下照常運作，effort 決策不受影響；`luna-decision-openai roles` 會顯示完整錯誤。

**如何決定**：
- 有 Luna 金鑰時：新 turn 的 Decisions 呼叫多一題 `choice`，選項為每位專家（名稱與一行說明）加上 `none`（問答、閒聊或沒有適合的專家）。Luna 的信心低於 `LUNA_ROLE_MIN_CONFIDENCE`（預設 0.4）或選 `none` 時，該 turn 不指派專家。
- 沒有金鑰（`auto→heuristic`、`heuristic`、`llm`）或 Luna 呼叫失敗時：依需求文字的關鍵字指派。團隊職位依內建規則（pytest／測試 → `test_engineer`，README／文件 → `technical_writer`，Python → `python_engineer` 等）；技能依名稱中的關鍵字（例如 `storage-backup-migration` 需要需求中出現 backup、migration 其中兩個詞）。沒有命中就不指派。
- 選出的專家在整個 turn 內不變，新 turn 重新挑選。只改模型、不帶 reasoning 的請求不指派。沒有需求文字時不問專家題目。
- Luna 沒有回答專家題目時（缺答或拒答），改由規則指派。
- 若 Decisions API 以 HTTP 400 拒絕帶專家題目的請求，程式去掉該題重試；重試成功，表示問題出在專家題目（例如選項過多），之後 30 分鐘內不再問，改由規則指派。重試也失敗則照一般錯誤處理，不停用專家題目。

**交給主模型的方式**：在每次 generation 的請求末端加一則 `[luna] For this request, work as the …` developer 訊息（Chat 為 system 訊息；`input` 為單一字串時先轉成一則 user 訊息再附加）。它會與計畫提醒、續跑焦點合併成同一則訊息，並註明「專案自己的指示優先」。`LUNA_ROLE_DELEGATE=on` 時，若團隊包有對應的 Codex 原生 subagent（`team_<職位>`，需另行安裝到 Codex），會另外建議主模型把實作委派給它並審查結果。主模型（`LUNA_MODEL`）不會因職位而切換，與工作包本身「模型繼承、不自動換」的政策一致。

**實測**（2026-10-29，`gpt-6-luna`，`agent-team-workflow` 13 位加 `storage-skills-pack` 15 個技能，共 29 個選項含 `none`）：

| 需求 | Luna 選擇 | effort |
|---|---|---|
| Add pytest unit tests for the CSV parser in src/parser.py and fix any failures | `python_engineer`（0.99） | medium |
| Plan a 3-2-1 backup and migrate the NAS to a new filesystem | `storage-backup-migration`（0.86） | xhigh |
| What is the difference between a mutex and a semaphore? | `none`（1.00） | low |

新 turn 的決策輸入由約 1.45k tokens 增加到約 3.2k tokens（多出的專家清單未被快取），單次上限約 $0.00032；turn 中的決策不受影響。以 `serve` 搭配模擬上游實跑，主模型確實收到對應職位的 developer 訊息。

**指令**：
- `luna-decision-openai roles`：列出載入的包與專家；若有 proxy 在跑，先顯示它的專家開關狀態。
- `luna-decision-openai roles on|off`：開關執行中 proxy 的專家功能。
- `luna-decision-openai roles <需求文字>`：顯示規則會選哪一位。
- `luna-decision-openai probe <需求文字>`：實際問 Luna 一次，顯示 effort、選中的專家與前三名機率。

**隱私與成本**：專家清單（名稱與一行說明，每位最多 160 字）會隨新 turn 的決策送到 OpenAI；技能內文只送給主模型的上游（使用 OpenRouter 時即第三方），不送給 Luna。專家越多，每個新 turn 的決策輸入越大：`E:\install_skills` 的 11 個包全部載入共 109 位，約多 4–5k tokens，並可能超出 Decisions API 的選項上限（此時依上述 400 處理改用規則）；建議只載入需要的包，或用 `LUNA_ROLE_SET` 限縮。

**已知限制**：Chat Completions 的提醒以結尾的 system 訊息送出。OpenAI 與 OpenRouter 接受這種寫法，但部分上游（如 Mistral API，以及某些 llama.cpp／Ollama 聊天模板）要求最後一則為 user 或 tool 訊息，可能拒絕；這類上游請勿設定 `LUNA_ROLE_PACK`。

## 憑證、上游與費用

**Luna 用哪把金鑰**（`src/router.js` 的 `decisionKeyFor`；變數來源與順序見上節「API keys」）：

1. `LUNA_API_KEY`；
2. 否則 `OPENAI_API_KEY`；
3. 否則（`LUNA_USE_CLIENT_KEY=on`，預設）客戶端自己送的 OpenAI 金鑰，但只在兩個條件都成立時：金鑰是 OpenAI 的格式（`sk-proj-`、`sk-svcacct-`、`sk-admin-`，或舊式 `sk-` 加 40 個以上英數字），且該請求本身就送往 OpenAI API（沒有設定 `LUNA_UPSTREAM`，`LUNA_API_UPSTREAM` 仍是 `api.openai.com`）。`sk-or-`、`sk-ant-` 等其他廠商的金鑰永遠不會送到 OpenAI。`OPENAI_ORG_ID`／`OPENAI_PROJECT_ID` 只搭配設定的金鑰送出，不搭配客戶端金鑰；
4. 都沒有 → 每次決策改用規則，`serve` 啟動時會提示。

**ChatGPT 登入不能用來付 Luna 的費用。** Codex 以 ChatGPT 登入時，它送出的是 JWT 或 `chatgpt-account-id`，這些不會用於 Decisions API。請設定 `OPENAI_API_KEY`。

**主模型上游**（`src/proxy.js` 的 `upstreamBase`）：`LUNA_UPSTREAM` 有設定時固定使用；否則 ChatGPT 登入 → `https://chatgpt.com/backend-api/codex`；`sk-or-` 金鑰 → `https://openrouter.ai/api/v1`；其他 → `https://api.openai.com/v1`。

**失敗時的暫停**（`src/decisions.js`）：逾時暫停 Luna 30 秒；401／403 暫停 10 分鐘；429 依 `Retry-After`，無此標頭則 60 秒。暫停期間直接用規則，不會每個 generation 都等逾時。暫停以「`LUNA_DECISION_URL` + 金鑰」為單位，一把壞掉的客戶端金鑰不會讓其他金鑰一起暫停。`Retry-After` 最多採計 10 分鐘。錯誤訊息寫入紀錄前會壓成一行、截到 120 字。API 若以含 "cache" 字樣的 400 拒絕 explicit cache，程式自動改用 implicit 重試，之後不再送 explicit。

**送給 Luna 的內容**：新 turn 送需求前 2000 字；turn 中送步驟描述與最近 8 步（指令前 160 字）；收工判斷送收尾文字末 800 字。預設送到 OpenAI。若 `LUNA_DECISION_URL` 指向其他位址，這些文字與金鑰也會送到該處。**隱私提醒**：即使主模型走 OpenRouter 或其他上游，這些需求文字與指令片段仍會送到 OpenAI 給 Luna 判斷；指令裡若含權杖（例如 `curl -H "Authorization: …"`）也會一併送出。不希望如此時請用 `LUNA_MODE=heuristic`。

## 安裝與使用

```powershell
luna-decision-openai install           # writes $CODEX_HOME\luna-decision.config.toml
luna-decision-openai codex             # starts the proxy if needed, then: codex -p luna-decision
luna-decision-openai codex exec "implement the plan in TODO.md and make the tests pass"

# live view: two windows
luna-decision-openai serve             # window 1
codex -p luna-decision                          # window 2
```

`install` 寫入的 profile 包含：`model = "gpt-6.1-terra"`（或 `--model` 指定者）、`model_reasoning_effort = "medium"`（`LUNA_DEFAULT_EFFORT`）、`model_provider = "luna-decision"`，以及指向 `http://127.0.0.1:8791/v1`、`wire_api = "responses"`、`requires_openai_auth = true` 的 `[model_providers.luna-decision]`。驗證行依 `--provider` 而定：`chatgpt` 寫入 `requires_openai_auth = true`（沿用 Codex 既有的登入）；`openai` 寫入 `env_key = "OPENAI_API_KEY"`；`openrouter` 寫入 `env_key = "OPENROUTER_API_KEY"`。`install --global` 寫入的 provider 表也使用同一行。檔案存在且不是本工具寫入時會拒絕覆寫，需加 `--force`。

`codex` 子指令會把 `--model` 同時傳給 Codex 的 `-m`。若 proxy 已在執行，請求中的其他已知模型 id（例如 `gpt-6.1-sol`）會原樣轉送，只改 effort。

### 指令

| 指令 | 用途 |
|---|---|
| `luna-decision-openai serve [--model M] [--effort E]` | 前景執行 proxy 並即時顯示決策。若埠已有本專案的 proxy，改為追蹤它的決策，不另起一個 |
| `luna-decision-openai install [--model M] [--effort E] [--provider P] [--force]` | 寫入 `$CODEX_HOME\luna-decision.config.toml`（profile `luna-decision`）。`--provider chatgpt`（預設）、`openai`（`OPENAI_API_KEY`）或 `openrouter`（`OPENROUTER_API_KEY`）決定主模型的驗證方式，見「API keys」 |
| `luna-decision-openai install --global` | 另把 luna-decision-openai 設為 `config.toml` 的預設 provider（給桌面版與 IDE 擴充；見下節） |
| `luna-decision-openai uninstall` | 還原 `config.toml` 並刪除 profile 檔（`config.toml.luna-decision-openai.bak` 保留） |
| `luna-decision-openai codex [--model M] [args...]` | 必要時背景啟動 proxy，再執行 `codex -p luna-decision [args...]` |
| `luna-decision-openai models` | 列出已知主模型（`*` 為預設）與 effort 階梯 |
| `luna-decision-openai probe [text]` | 實際呼叫一次 `gpt-6-luna`，印出回答、換算的 effort、耗時、輸入 tokens 與費用上限。只使用 `OPENAI_API_KEY` 或 `LUNA_API_KEY`，不使用客戶端金鑰 |
| `luna-decision-openai tail` | 即時追蹤決策 |
| `luna-decision-openai stats` | 依 effort 統計 generation 數、平均 reasoning tokens 與輸出 tokens；列出續跑次數與 Luna 費用上限 |
| `luna-decision-openai status` | 顯示執行中 proxy 的版本與 build；未執行或版本過舊時 exit 1 |
| `luna-decision-openai stop` | 停止執行中的 proxy（只停 `/luna/health` 回報 app 為 `luna-decision-openai` 的程序） |
| `luna-decision-openai --version` | 磁碟上程式碼的版本與 build（也接受 `-v`） |

`--model M`、`--effort E`、`--provider P`（也接受 `--model=M` 等形式）可用於 `serve`、`install`、`codex`、`models`、`probe`、`status`。

更新程式碼後請重啟 proxy：`status` 會回報 stale，此時執行 `stop` 再重新 `serve` 或 `codex`。

### 決策顯示格式（示意，數值為舉例）

```
Luna  HIGH  SELECTED
     id: 3f2c… · Step 2 · source: luna · luna: high, heuristic: medium · next 1 generation(s) · 180 ms · luna high (score 1.40, confidence 0.62); stuck 0.20
Luna  RESUME #1 → MEDIUM  ✓ APPLIED
     Step 3 · unfinished 0.61 · source: luna · luna done 0.20, in progress 0.61 · …
```

決策行標示 `SELECTED`；續跑行標示 `RESUME #n → 級別  ✓ APPLIED`。`LUNA_QUIET=1` 會隱藏這些輸出（不影響紀錄檔）。

### Codex 桌面版與 IDE 擴充

桌面版與 IDE 擴充不能使用 `-p`，只讀 `$CODEX_HOME\config.toml`，因此需要 `--global`：

```powershell
luna-decision-openai install --global  # 首次會備份成 config.toml.luna-decision-openai.bak
luna-decision-openai serve             # keep it running; the desktop app does not start the proxy
luna-decision-openai uninstall         # restores config.toml
```

`--global` 在 `config.toml` 最前面加入 `model_provider`、`model`、`model_reasoning_effort`，並在檔尾加入 `[model_providers.luna-decision]`。這些行夾在 `# >>> luna-decision-openai` 與 `# <<< luna-decision-openai` 標記之間。原本的同名頂層設定改為 `# luna-decision-openai saved: …` 註解，`uninstall` 會逐行還原。

注意：之後**所有** Codex 客戶端（包括直接執行的 `codex`）都會經過 proxy，proxy 沒開就連不上。proxy 只處理 HTTP，若桌面版改走 websocket 傳輸，請求不會經過 proxy。桌面版尚未實測。

### Chat Completions 客戶端

proxy 同時代理 `POST /v1/chat/completions`。請求帶有 `reasoning_effort` 字串或 `reasoning` 物件時套用 effort；`luna-auto`／`auto` 別名會改寫為設定的模型，OpenRouter 的 `sk-or-` 金鑰會自動走 OpenRouter。計畫提醒適用，續跑不適用。

以下為 opencode 設定範例（未實測）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "luna": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "luna-decision-openai",
      "options": { "baseURL": "http://127.0.0.1:8791/v1", "apiKey": "{env:OPENAI_API_KEY}" },
      "models": { "luna-auto": { "name": "GPT-6.1 Terra (luna effort)" } }
    }
  }
}
```

aider 範例（未實測）：`aider --openai-api-base http://127.0.0.1:8791/v1 --model openai/luna-auto`

### Windows 沙箱提示

建議在專案資料夾內啟動 Codex，不要在家目錄（例如 `C:\Users\<你>`）下啟動。本專案未在家目錄情境下實測。

## 設定（環境變數）

預設值取自 `src/config.js` 與 `bin/luna.js`。非法值會在啟動時報錯。所有 CLI 指令啟動時都會先讀取 `.env.local`／`.env`（順序見「API keys」），系統環境變數優先。

| 變數 | 預設 | 說明 |
|---|---|---|
| `LUNA_PORT` | `8791` | 監聽埠 |
| `LUNA_HOST` | `127.0.0.1` | 監聽位址 |
| `LUNA_MODEL` | `gpt-6.1-terra` | 主模型 id；`luna-auto` 別名與此 id 會改寫為它（`--model` 設定同一個值） |
| `LUNA_MODELS` | 空 | 額外的主模型 id（逗號分隔），會列在 `models` 中 |
| `LUNA_AUTO_MODELS` | `luna-auto,auto` | 會交由 router 改寫為 `LUNA_MODEL` 的客戶端模型名稱 |
| `LUNA_LEVELS` | `low,medium,high,xhigh,max` | effort 階梯，必須由低到高、不可重複，也是 Luna 的選項；luna 模式至少要 2 級 |
| `LUNA_DEFAULT_EFFORT` | `medium` | 新 turn 的規則預設、續跑後的下限；必須在階梯內（`--effort` 設定同一個值） |
| `LUNA_MODE` | `auto` | `auto`（有金鑰用 `luna`，沒有用 `LUNA_AUTO_FALLBACK`）；`luna`；`heuristic`（只用規則，不呼叫 Luna）；`llm`（以 `LUNA_JUDGE_MODEL` 或主模型做判官，只在 Responses 第 2 步起）；`off`（不改 effort，只改別名模型）。詳見「運作模式」 |
| `LUNA_AUTO_FALLBACK` | `heuristic` | `auto` 模式下沒有金鑰的請求改用的模式：`heuristic` 或 `llm` |
| `LUNA_ROLE_PACK` | 空（關閉） | 專家包路徑（zip 或資料夾），以 `;` 分隔多個，每個可加 `\|組合`；見「專家角色」 |
| `LUNA_ROLES` | `on` | proxy 啟動時是否使用專家；執行中可用 `roles on`／`roles off` 切換 |
| `LUNA_ROLE_SET` | 空（團隊包取 `product`，否則取全部） | 預設的職位組合：profile 名稱、`author` 或逗號分隔的 id |
| `LUNA_ROLE_MIN_CONFIDENCE` | `0.4` | Luna 選專家的信心低於此值就不指派 |
| `LUNA_ROLE_DELEGATE` | `off` | `on` 時另建議委派給團隊包對應的 Codex 原生 subagent（`team_<職位>`） |
| `LUNA_DECISION_URL` | `https://api.openai.com/v1/decisions` | Decisions API 端點 |
| `LUNA_DECISION_MODEL` | `gpt-6-luna` | 決策模型 |
| `LUNA_API_KEY` | 空 | 決策用金鑰，優先於 `OPENAI_API_KEY` |
| `OPENAI_API_KEY` | 空 | Luna 決策的金鑰（`probe` 只用這個或 `LUNA_API_KEY`）；`--provider openai` 時也是主模型的金鑰 |
| `OPENROUTER_API_KEY` | 空 | `--provider openrouter` 時主模型的金鑰（`sk-or-`）。Luna 仍需 `OPENAI_API_KEY` |
| `LUNA_USE_CLIENT_KEY` | `on` | 無上述金鑰時，使用客戶端的 OpenAI 格式金鑰，且僅限請求本身送往 OpenAI API 時（`off` 關閉） |
| `OPENAI_ORG_ID`（或 `OPENAI_ORGANIZATION`） | 空 | 送出 `openai-organization` 標頭 |
| `OPENAI_PROJECT_ID`（或 `OPENAI_PROJECT`） | 空 | 送出 `openai-project` 標頭 |
| `LUNA_DECISION_TIMEOUT_MS` | `3000` | 單次決策逾時（至少 1）；逾時後暫停 Luna 30 秒 |
| `LUNA_CACHE` | `explicit` | `explicit`：rubric 標記 cache breakpoint 並送 `prompt_cache_options`；`implicit`：不標 breakpoint，只送 `prompt_cache_key`；`off`：不送任何快取欄位 |
| `LUNA_MIN_CONFIDENCE` | `0.4` | Luna 信心低於此值即棄權，改用規則 |
| `LUNA_EFFORT_QUANTILE` | `0.5` | 取 Luna 機率分布的哪個分位數作為級別；越高越偏向較高 effort |
| `LUNA_CONTINUE` | `on` | 提早收工時自動續跑（僅 Responses 串流） |
| `LUNA_MAX_CONTINUES` | `20` | 每個 turn 最多續跑次數（含自我審查輪） |
| `LUNA_MAX_STALLS` | `2` | 自上次有進展的續跑之後，再允許幾次無進展的續跑；`0` 只在有進展後才續跑 |
| `LUNA_VERIFY` | `on` | 改了程式卻未驗證，或測試在最後一次修改後仍失敗，視為未完成 |
| `LUNA_REVIEW_ROUNDS` | `1` | 每個 turn 的自我審查輪數；`0` 關閉 |
| `LUNA_CONTINUE_THRESHOLD` | `0.6` | `unfinished` 達此值才續跑（0–1） |
| `LUNA_NUDGE` | `on` | 計畫有未完成步驟時於請求末端附加提醒 |
| `LUNA_JUDGE_MODEL` | 空（沿用請求的模型，routed 時為主模型） | `LUNA_MODE=llm` 的判官模型 |
| `LUNA_JUDGE_EFFORT` | `low` | 判官的 effort |
| `LUNA_JUDGE_TIMEOUT_MS` | `2500` | 判官逾時 |
| `LUNA_PROVIDER` | `chatgpt` | `chatgpt`、`openai` 或 `openrouter`：`install` 寫入的主模型驗證方式（`--provider` 設定同一個值） |
| `LUNA_UPSTREAM` | 空 | 固定主模型上游；設定後忽略憑證判斷 |
| `LUNA_CHATGPT_UPSTREAM` | `https://chatgpt.com/backend-api/codex` | ChatGPT 登入的上游 |
| `LUNA_API_UPSTREAM` | `https://api.openai.com/v1` | API 金鑰的上游 |
| `LUNA_OPENROUTER_UPSTREAM` | `https://openrouter.ai/api/v1` | `sk-or-` 金鑰的上游 |
| `LUNA_HOME` | `~/.luna-decision-openai` | 紀錄檔與 `proxy.log` 所在位置 |
| `LUNA_QUIET` | 未設定 | `1` 時不在終端機印出決策 |
| `CODEX_HOME` | `~/.codex` | `install`、`uninstall`、`install --global` 寫入的目錄（CLI 讀取，非 `config.js`） |

## 紀錄檔與統計

位於 `LUNA_HOME`（預設 `~/.luna-decision-openai`）：

- `decisions.jsonl`：每個 routed generation 在回應結束後寫入一行，包含 `ts`、`session`、`api`、`step`、`effort`、`from`、`hold`、`reasons`、`source`、`cost`、`ms`、`model`、`requested`、`usage`、`status`，視情況另有 `suggestions`（Luna 與規則各自建議）、`adjustment`、`nudged`、`continues`（每次續跑一筆：`n`、`kind`（`resume` 或 `review`）、`effort`、`unfinished`、`source`、`reasons`，續跑另有 `stalls`）。`stats` 讀的是這個檔。
- 只改模型的 `luna-auto` 請求（沒有 reasoning 參數）不呼叫 Luna，`source` 為 `model only`，effort 不套用。
- `events.jsonl`：決策選定時寫入一行 `decision`，完成或失敗時寫入 `completed`／`failed`，以同一 `id` 對應。`tail` 在此檔存在時讀它，否則讀 `decisions.jsonl`；新版 proxy 的 `serve` 追蹤的也是此檔。
- `proxy.log`：`codex` 子指令背景啟動的 proxy 的輸出。

`/luna/health` 回報 `app`、`version`、`build`、`pid`、`startedAt`、`mode`、`model`、`ladder`、`decisionModel` 與 `stats`（`requests`、`routed`、`byEffort`、`reasoningTokens`、`continued`、`reviewed`、`nudged`）。

## 架構

| 檔案 | 職責 |
|---|---|
| `src/config.js` | 環境變數、預設值與驗證 |
| `src/decisions.js` | Luna 決策：`effortCall()`、`situation()`、`requestBody()`（rubric 與快取欄位）、`toAssessment()`、`combineEffort()`（把關）、`lunaStopCheck()`、暫停與 explicit cache 退回 |
| `src/policy.js` | 規則 `assess()` 與升降級 `nextState()` |
| `src/router.js` | 金鑰選擇 `decisionKeyFor()`、各 session 的 effort 狀態與續跑次數 |
| `src/longtask.js` | 計畫解析 `turnPlan()`、收尾文字 `finalOutput()`、規則版收工判斷 `assessStop()`、驗證狀態 `verification()`、進展標記 `progressOf()`、提醒、續跑與自我審查訊息 |
| `src/splice.js` | SSE 切分、暫扣 `response.completed`、把續跑回應接在同一條串流上 |
| `src/trajectory.js`、`src/chat.js` | Responses 與 Chat Completions 的軌跡解析 |
| `src/judge.js` | `LUNA_MODE=llm` 的判官 |
| `src/roles.js` | 專家包讀取（團隊包與技能包，zip 或資料夾）、職位組合、Luna 專家題目、規則指派與交給主模型的訊息 |
| `src/model.js` | 模型 id、`luna-auto` 別名、effort 對齊（`minimal` → `low`） |
| `src/proxy.js` | HTTP proxy：解壓、改寫、提醒、續跑、紀錄、`/luna/health` |
| `src/codexconfig.js` | `install --global` 對 `config.toml` 的可逆編輯 |
| `src/log.js`、`src/version.js` | 決策格式與紀錄；版本與 build 指紋 |
| `bin/luna.js` | CLI |

## 已驗證事項

- **Live Decisions 呼叫（2026-10-29）**：`luna-decision-openai probe` 對 `gpt-6-luna` 呼叫成功，API 接受 explicit cache breakpoint（請求形狀：rubric 的 `prompt_cache_breakpoint`、`prompt_cache_options`、`prompt_cache_key`，state 為 `input_json`）。首次呼叫後，約 1.45k 輸入 tokens 中有 1236 個為快取命中。暖機後延遲 400–700 ms，首次冷啟動約 2 秒。單次決策費用不超過 $0.00015（以未快取價計算的上限）。
- CLI（臨時目錄）：`--version`、`models`、`install`（含 `--model`、`--effort`）、`install --global` 與 `uninstall` 的產物與還原已核對；無金鑰的 `probe` 會明確報錯並以 exit 1 結束。

## 限制與未驗證事項

- **未實測：** Codex 桌面版（`install --global`）、websocket 傳輸、長任務端到端效果，以及 `max` 與 `gpt-6.1-sol`、`gpt-6-astra` 的 effort 支援。程式只把 `minimal` 對應為 `low`，其餘 effort 原樣送出。
- 本 repo 目前沒有 Luna 效果量測腳本。預設門檻（`LUNA_MIN_CONFIDENCE` 0.4、`LUNA_CONTINUE_THRESHOLD` 0.6、`LUNA_MAX_CONTINUES` 20、`LUNA_MAX_STALLS` 2、`LUNA_REVIEW_ROUNDS` 1、`LUNA_DECISION_TIMEOUT_MS` 3000）尚未以真實工作量調校。量測時請看 `stats` 與 `decisions.jsonl`。
- Luna 只收到結構化摘要（請求、步驟摘要、最近 8 步、收尾文字末 800 字），不會收到完整對話。
- 規則的困難需求偵測是關鍵字比對，有漏判與誤判的可能。
- 續跑與自我審查的每一代同樣計入上游帳單；預設上限每 turn 20 次。自我審查預設每個改過程式的 turn 多一代。`decisions.jsonl` 的 `usage` 是 proxy 所見的最後一個 usage（續跑情況未實測）。
- Chat Completions 不續跑；Codex 的 websocket 傳輸不經過 proxy。

## 測試與變更歷史

```powershell
npm test     # node --test (test/)
```

| 版本 | 內容 |
|---|---|
| v0.4.0（分支 `feat/luna-role-routing`） | 專家角色：`LUNA_ROLE_PACK` 載入團隊工作包與技能包（可多個），新 turn 由 Luna 在同一次 Decisions 呼叫中選擇專家（沒有金鑰時依關鍵字），選中的工作方式以 developer 訊息交給主模型；新增 `roles` 指令，`probe` 顯示專家選擇；`LUNA_ROLES` 與 `roles on|off`（`POST /luna/roles`）可開關專家，不需重啟 |
| v0.3.0 | 新增 `LUNA_MODE=auto` 並設為預設：每個請求有 Luna 金鑰就用 `luna`，沒有就用 `LUNA_AUTO_FALLBACK`（預設 `heuristic`，可選 `llm`）；`serve` 顯示 `auto→luna`／`auto→heuristic`；`/luna/health` 回報 `autoFallback` |
| v0.2.0 | 長任務持續與自我迭代：續跑上限改為每 turn 20 次＋無進展上限（`LUNA_MAX_STALLS`，預設 2）；續跑後的焦點提醒；只改模型的請求也會在新 turn 重設續跑預算；驗證關卡（`LUNA_VERIFY`：改了程式未驗證或測試仍失敗即續跑）；自我審查輪（`LUNA_REVIEW_ROUNDS`）；續跑提醒引用失敗指令並警告停滯；`stats` 與 `/luna/health` 計入自我審查 |
| v0.1.0 | 初始建立：決策改由 OpenAI `gpt-6-luna`（Decisions API）；主模型預設 `gpt-6.1-terra`，可選 `gpt-6.1-sol`、`gpt-6-astra`；effort 階梯 `low`～`max`；規則把關與續跑；CLI `luna-decision-openai`（埠 8791、profile `luna-decision`） |
