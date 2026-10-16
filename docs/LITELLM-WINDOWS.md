# Local LiteLLM on Windows

This guide is for trying one small real request on your own computer. It does not deploy Orchestra, and it does not start a paid evaluation for you.

Orchestra already has three safe modes:

- **Simulation** answers with a labeled placeholder and does not call a model.
- **Mock evaluation** writes synthetic Stage B and Stage C results. Those results are not evidence of savings or quality.
- **Ollama** can call a model that is already installed on your machine. That path does not use LiteLLM.

The real LiteLLM path is a fourth mode. It stays off until you set `EVAL_EXECUTION=real` and a request limit. You do not have to do that to use the rest of the app.

## Two different environments

The LiteLLM **gateway** and the Orchestra **app** are separate programs. Each one has its own environment variables.

| Program | What it needs | Where it belongs |
| --- | --- | --- |
| LiteLLM gateway | `OPENAI_API_KEY` (your provider key) and `LITELLM_MASTER_KEY` (a password you invent for the gateway) | The PowerShell window where you start the gateway |
| Orchestra | `LITELLM_URL` and the same `LITELLM_MASTER_KEY` | `.env.local`, which Git already ignores |

Do not put the provider key in `.env.local`. Orchestra only needs the gateway password so it can talk to the program on your computer. The gateway is the program that talks to the paid provider.

Do not paste either secret into chat, a screenshot, or a Git commit. `.env.example` contains placeholders only.

## What is already in the project

These files are already present:

- `.env.example` — placeholders for `LITELLM_URL` and `LITELLM_MASTER_KEY`
- `.gitignore` — ignores `.env.local`, the SQLite database, and real evaluation output
- `eval/stage-a/litellm/config.yaml` — the local model list: `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, and `smart-router`

`smart-router` is only the Stage A baseline. Orchestra does not send that name. It chooses one of the three aliases in `lib/engine.ts` and asks the gateway to run that alias.

JavaScript dependencies are not installed in this checkout yet. Installing them is separate from installing LiteLLM, and neither step downloads a language model.

## 1. Install JavaScript dependencies when you are ready

Open PowerShell in the project folder:

```powershell
cd C:\Users\nbnit\pm-with-ai-cc5389
npm ci
```

This installs the packages in `package-lock.json`. It does not call a model provider.

Check the app without a gateway:

```powershell
npm test
npm run typecheck
npm run dev
```

The dev server binds to `127.0.0.1` only. Open `http://127.0.0.1:3000` on this computer. Do not put Orchestra on a public host.

## 2. Create the app's private env file

Run this once. It will not overwrite an existing file.

```powershell
cd C:\Users\nbnit\pm-with-ai-cc5389
if (-not (Test-Path .env.local)) {
  Copy-Item .env.example .env.local
}
notepad .env.local
```

In Notepad, uncomment these two lines and set the gateway password you are about to invent. Leave `OPENAI_API_KEY` out of this file.

```text
LITELLM_URL=http://127.0.0.1:4000/v1/chat/completions
LITELLM_MASTER_KEY=replace-with-the-private-gateway-password
```

Save and close Notepad. `.env.local` stays on this computer.

## 3. Start the gateway in its own window

Install LiteLLM only when you want the gateway. This command installs it for your Windows user. It does not install a model.

```powershell
py -3 -m pip install "litellm[proxy]"
```

Open a **second** PowerShell window. Set the gateway's own variables in that window. They disappear when you close it. Replace the two quoted values yourself; do not commit them.

```powershell
cd C:\Users\nbnit\pm-with-ai-cc5389
$env:OPENAI_API_KEY = "your-provider-key"
$env:LITELLM_MASTER_KEY = "the-same-private-gateway-password"
litellm --config eval/stage-a/litellm/config.yaml --host 127.0.0.1 --port 4000
```

`--host 127.0.0.1` keeps the gateway on this computer. Do not add a firewall rule that publishes port 4000.

If PowerShell says `litellm` is not recognized, close and reopen the window after the install, or run:

```powershell
py -3 -m litellm --config eval/stage-a/litellm/config.yaml --host 127.0.0.1 --port 4000
```

Leave this window open. The gateway reads `OPENAI_API_KEY` from this process because `config.yaml` says `os.environ/OPENAI_API_KEY`. Orchestra never reads that provider key for this path.

Stop the gateway later with `Ctrl+C` in this same window.

## 4. Send one small request to the gateway

This step is optional and spends a small amount of provider credit. It talks to the gateway directly. It does not write Orchestra's history database, and it is not a Stage B or Stage C result.

Stay in the gateway window, where `LITELLM_MASTER_KEY` is already set:

```powershell
$headers = @{ Authorization = "Bearer $env:LITELLM_MASTER_KEY" }
$body = @{
  model = "gpt-4.1-nano"
  messages = @(@{ role = "user"; content = "Reply with the single word ok." })
  max_tokens = 16
  temperature = 0
} | ConvertTo-Json -Depth 5
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:4000/v1/chat/completions" `
  -Headers $headers `
  -Body $body `
  -ContentType "application/json"
```

`gpt-4.1-nano` is the cheapest alias in the shared pool. A successful reply means the gateway accepted the key and called the provider. An error here is a gateway or provider error, not an Orchestra routing result. Orchestra will not replace that error with a mock answer.

## 5. Later, run one Orchestra request

Do this only when you intend to pay for two calls: one baseline call and one Orchestra call. The baseline may call `smart-router`. Orchestra calls the single alias selected by `lib/engine.ts`.

Use a third PowerShell window, or the original project window. It loads `.env.local` and does not need `OPENAI_API_KEY`.

```powershell
cd C:\Users\nbnit\pm-with-ai-cc5389
$env:EVAL_EXECUTION = "real"
$env:EVAL_LIMIT = "1"
node --env-file=.env.local --import tsx eval/stage-b/run.ts
```

What that does:

- `EVAL_EXECUTION=real` turns off the mock adapter. If the gateway fails, the file records the error. It does not invent a mock response.
- `EVAL_LIMIT=1` is required. If you forget it, the runner stops before any paid call.
- The `1` means the first Stage B scenario for each system, not the full 60-scenario study.
- The result is `eval/results/stage-b/real-results.json`. Git ignores that file.
- Each request updates that experiment's budget once. This ledger is not the app's SQLite history.

Read the saved JSON for the requested model, the returned model, token counts, latency, cost, remaining budget, and any error. `costBasis` is `actual` when the gateway sends a cost header. It is `estimated` when the cost was calculated from the frozen price snapshot. Quality and latency used to choose a model are estimates, not guarantees.

The full Stage B study would be `EVAL_LIMIT=60`. The full Stage C study would be `EVAL_LIMIT=200` with `eval/stage-c/run.ts`. Both can spend real money. Do not set those values until you mean to pay for the whole run.

Judge quality later with the existing judge command. A generation file does not contain a quality score, and a mock file must not be used as one.

## If something fails

- **Connection refused:** the gateway window is not running, or it is not on port 4000.
- **401 from the gateway:** `LITELLM_MASTER_KEY` in `.env.local` does not match the gateway window.
- **Provider authentication error:** the gateway window is missing `OPENAI_API_KEY`, or the key was rejected. Fix it in the gateway window. Do not add it to the Orchestra page.
- **Unresolved cost:** a timeout or an HTTP error may have been billed even though the gateway did not report a price. The saved cost is the original reservation, labeled unresolved, so that amount stays locked. The same request is not sent again. Check the gateway bill before treating that row as a measured price.
- **Rejected before a call:** Orchestra's policy or the remaining budget blocked the request. The saved cost is zero because no provider call was made.
