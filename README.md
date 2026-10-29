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
- OpenAI API 金鑰（`OPENAI_API_KEY` 或 `LUNA_API_KEY`）。`LUNA_MODE=heuristic` 只用規則，不需要金鑰。

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

主模型在長任務中常提早結束 turn：寫一段摘要、說「接下來我會…」、或問「要我繼續嗎？」，但工作其實沒做完。本專案有兩個機制處理這件事。

### 1. 計畫提醒（nudge，`LUNA_NUDGE=on`）

本輪計畫（Codex 的 `update_plan`；Chat 另讀 `todowrite`／`TodoWrite`）還有未完成步驟時，proxy 在每次 generation 前於請求末端附加提醒：已完成幾步、還剩哪些、全部完成並驗證前不要收工、不要停下來問是否繼續。Responses 以 developer 訊息附加，Chat 以 system 訊息附加。

### 2. 提早收工自動續跑（resume，`LUNA_CONTINUE=on`）

只適用於串流的 Responses 請求（Codex）。Chat Completions 不續跑。

proxy 會暫扣上游的 `response.completed`。若同時符合以下條件，就立即帶著原請求、剛才的輸出與一則 `[luna]` 提醒再送一次，新事件接在同一條串流上送回客戶端，客戶端只看到一個完整 turn：

- 這一代沒有需要客戶端執行的工具呼叫（即要把控制權交還使用者）；
- 本輪做過事，或有計畫；
- 本輪續跑次數未達 `LUNA_MAX_CONTINUES`（預設 5）；
- `unfinished` ≥ `LUNA_CONTINUE_THRESHOLD`（預設 0.6）。

續跑的那一代 effort 提高一級（至少為預設值）。

**收工判斷（`lunaStopCheck`）**：

1. 硬規則先決，不問 Luna：沒有任何工作 → 0；計畫仍有未完成步驟 → 0.9；收尾向使用者索取只有他能給的東西（金鑰、密碼、請提供、請先登入 等）→ 0.1。
2. 否則把收尾文字末 800 字，加上請求與步數，送給 Luna 一次，同時問兩題：
   - `end`（choice）：`will_continue`（打算或提議繼續）、`done`（說任務完成）、`needs_user`（需要使用者的金鑰、密碼、登入或決定）、`other`。
   - `in_progress`（predicate）：部分完成、還有剩。
3. 合併：`end` 為 `needs_user` → `unfinished` = P(will_continue)。其他情況 → max(P(will_continue), P(in_progress), 規則分數)。例外：`end` 為 `done` 且機率 ≥ 0.9 時，不採計 `in_progress`。
4. 規則分數：徵求許可的問句（would you like me to…?、要我…嗎？）或第一人稱承諾（next I'll、I will fix…、接下來我會、我會再修…）為 0.75；最後一步失敗為 0.5；其餘為 0.1。「if you want, I'll add docs」這類條件式提議不算承諾。

Luna 失敗時只用規則。`LUNA_MODE=heuristic` 或 `llm` 也只用規則；`LUNA_MODE=off` 不續跑。

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

`--global` 在 `config.toml` 最前面加入 `model_provider`、`model`、`model_reasoning_effort`，並在檔尾加入 `[model_providers.luna]`。這些行夾在 `# >>> luna-decision-openai` 與 `# <<< luna-decision-openai` 標記之間。原本的同名頂層設定改為 `# luna-decision-openai saved: …` 註解，`uninstall` 會逐行還原。

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
| `LUNA_MODE` | `luna` | `luna`；`heuristic`（只用規則，不呼叫 Luna）；`llm`（以 `LUNA_JUDGE_MODEL` 或主模型做判官，只在 Responses 第 2 步起）；`off`（不改 effort，只改別名模型） |
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
| `LUNA_MAX_CONTINUES` | `5` | 每個 turn 最多續跑次數 |
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

- `decisions.jsonl`：每個 routed generation 在回應結束後寫入一行，包含 `ts`、`session`、`api`、`step`、`effort`、`from`、`hold`、`reasons`、`source`、`cost`、`ms`、`model`、`requested`、`usage`、`status`，視情況另有 `suggestions`（Luna 與規則各自建議）、`adjustment`、`nudged`、`continues`。`stats` 讀的是這個檔。
- 只改模型的 `luna-auto` 請求（沒有 reasoning 參數）不呼叫 Luna，`source` 為 `model only`，effort 不套用。
- `events.jsonl`：決策選定時寫入一行 `decision`，完成或失敗時寫入 `completed`／`failed`，以同一 `id` 對應。`tail` 在此檔存在時讀它，否則讀 `decisions.jsonl`；新版 proxy 的 `serve` 追蹤的也是此檔。
- `proxy.log`：`codex` 子指令背景啟動的 proxy 的輸出。

`/luna/health` 回報 `app`、`version`、`build`、`pid`、`startedAt`、`mode`、`model`、`ladder`、`decisionModel` 與 `stats`（`requests`、`routed`、`byEffort`、`reasoningTokens`、`continued`、`nudged`）。

## 架構

| 檔案 | 職責 |
|---|---|
| `src/config.js` | 環境變數、預設值與驗證 |
| `src/decisions.js` | Luna 決策：`effortCall()`、`situation()`、`requestBody()`（rubric 與快取欄位）、`toAssessment()`、`combineEffort()`（把關）、`lunaStopCheck()`、暫停與 explicit cache 退回 |
| `src/policy.js` | 規則 `assess()` 與升降級 `nextState()` |
| `src/router.js` | 金鑰選擇 `decisionKeyFor()`、各 session 的 effort 狀態與續跑次數 |
| `src/longtask.js` | 計畫解析 `turnPlan()`、收尾文字 `finalOutput()`、規則版收工判斷 `assessStop()`、提醒與續跑訊息 |
| `src/splice.js` | SSE 切分、暫扣 `response.completed`、把續跑回應接在同一條串流上 |
| `src/trajectory.js`、`src/chat.js` | Responses 與 Chat Completions 的軌跡解析 |
| `src/judge.js` | `LUNA_MODE=llm` 的判官 |
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
- 本 repo 目前沒有 Luna 效果量測腳本。預設門檻（`LUNA_MIN_CONFIDENCE` 0.4、`LUNA_CONTINUE_THRESHOLD` 0.6、`LUNA_MAX_CONTINUES` 5、`LUNA_DECISION_TIMEOUT_MS` 3000）尚未以真實工作量調校。量測時請看 `stats` 與 `decisions.jsonl`。
- Luna 只收到結構化摘要（請求、步驟摘要、最近 8 步、收尾文字末 800 字），不會收到完整對話。
- 規則的困難需求偵測是關鍵字比對，有漏判與誤判的可能。
- 續跑的那一代同樣計入上游帳單。`decisions.jsonl` 的 `usage` 是 proxy 所見的最後一個 usage（續跑情況未實測）。
- Chat Completions 不續跑；Codex 的 websocket 傳輸不經過 proxy。

## 測試與變更歷史

```powershell
npm test     # node --test (test/)
```

| 版本 | 內容 |
|---|---|
| v0.1.0 | 初始建立：決策改由 OpenAI `gpt-6-luna`（Decisions API）；主模型預設 `gpt-6.1-terra`，可選 `gpt-6.1-sol`、`gpt-6-astra`；effort 階梯 `low`～`max`；規則把關與續跑；CLI `luna-decision-openai`（埠 8791、profile `luna-decision`） |
