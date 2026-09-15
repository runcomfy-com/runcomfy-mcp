# RunComfy for Dify

Run ComfyUI workflows in the cloud. Use RunComfy as an **AI image generator**, **AI video generator**, and **LoRA training** service from Dify agents, chatflows, and workflows.

Discover AI image models and AI video models from **Seedance, Wan, FLUX, LTX, and Seedream**, inspect their current input schemas and pricing, and submit jobs on RunComfy GPU infrastructure. Search by the exact model or version you need; availability and pricing come from the live API rather than a fixed list in this plugin.

- [RunComfy models](https://www.runcomfy.com/models)
- [API documentation](https://docs.runcomfy.com/)
- [Public plugin source](https://github.com/runcomfy-com/runcomfy-mcp/tree/codex/dify-marketplace-plugin/integrations/dify)
- [Privacy policy](PRIVACY.md)
- Support: [hi@runcomfy.com](mailto:hi@runcomfy.com)

## Setup

1. Create or sign in to your [RunComfy account](https://www.runcomfy.com/auth/sign-in). Obtain an API token from your account settings.
2. Install the RunComfy plugin in Dify. During pre-release testing, use **Plugins → Install plugin → Local package file** and select the supplied `.difypkg`.
3. Open RunComfy authorization and enter the token in the **RunComfy API token** secret field. Validation makes a read-only balance request; it does not start a job.
4. Add a RunComfy tool to a Dify workflow or agent. Enable **Allow paid run** in each submission tool only when that workflow is permitted to spend RunComfy credit. Discovery and status tools do not need that setting.

This plugin requires Python 3.12 in the Dify plugin runtime and the dependencies in `requirements.txt`. Your Dify environment must permit HTTPS access to `api.runcomfy.net`, `model-api.runcomfy.net`, and `trainer-api.runcomfy.net`. It uses your RunComfy account and balance; it does not require a separate OpenAI API key or a local ComfyUI installation.

## Tools

| Tool | Purpose |
| --- | --- |
| Browse AI Image and Video Models | Search model names or categories; returns current model IDs, pricing, and input summaries. |
| Get Model Input Schema | Retrieve the selected model's full input schema and pricing. |
| Generate Image or Video | Start a paid generation job with the model ID and schema-compatible JSON inputs. |
| List ComfyUI Deployments | List existing serverless deployments in your RunComfy account. |
| Get ComfyUI Deployment | Read a deployment's workflow payload and README before running it. |
| Run ComfyUI Workflow | Start a paid inference job using documented overrides or workflow API JSON. |
| Start LoRA Training | Start a paid AI Toolkit training job using a prepared YAML configuration and dataset. |
| Get Job Status | Make one status request for a model, workflow, or training job. |
| Get Job Result | Retrieve generation outputs or training artifact URLs. |

## Image and video workflow

1. Use **Browse AI Image and Video Models**, for example `search=FLUX` and `category=text-to-image`.
2. Copy a returned `model_id` into **Get Model Input Schema**. Check the required fields and pricing.
3. Supply that exact model ID to **Generate Image or Video**. Set **Model inputs JSON** to an object matching the schema. A prompt-only model might accept `{"prompt":"A red bicycle on a quiet street"}`; image-to-video models normally also require an image field. The model's schema determines the actual keys. Do not wrap the object inside `inputs`.
4. Save the returned `request_id`. Call **Get Job Status** with `service=model` and that ID.
5. When the status reports completion, call **Get Job Result** with the same values. Pass the returned JSON/URLs to downstream Dify nodes.

For video generation, search Seedance, Wan, or LTX, inspect the chosen model's schema, then use the same submission and status flow. Choose duration, resolution, and other parameters according to the selected schema and your budget.

## ComfyUI workflow

Create a serverless deployment in RunComfy first. Use **List ComfyUI Deployments**, then **Get ComfyUI Deployment** to obtain its expected payload. Supply its ID and a JSON object with `overrides` and/or `workflow_api_json` to **Run ComfyUI Workflow**. Use `{}` to run the saved default inputs. When passing `workflow_api_json`, omit `overrides` or keep it empty. Optional `extra_data` is supported. For example, when the deployment documents prompt node `6`, an override may be `{"overrides":{"6":{"inputs":{"text":"A red bicycle"}}}}`. Node IDs and input names belong to your deployed workflow; do not assume this example matches yours.

Save the returned `request_id` and poll with `service=workflow`, that ID, and the same deployment ID. This plugin does not create deployments, start arbitrary instance proxies, or download user-selected URLs.

## LoRA training workflow

Prepare and upload the training dataset in RunComfy, then obtain a working [AI Toolkit training configuration](https://docs.runcomfy.com/). Pass the complete YAML to **Start LoRA Training** and select one H100 or H200 GPU. The YAML is sent to the RunComfy Trainer API and is not executed by Dify. Save the returned job ID and use `service=training` for subsequent status and result requests. Dataset upload, multi-GPU setup, resume, and cancellation are managed through the RunComfy account/API and are outside this initial plugin.

## Asynchronous execution and billing

Every submission starts a new billable job and returns immediately after the API acknowledges it. The tools do not wait for GPU generation or training, retry submissions, or automatically poll. Use a bounded Dify loop with a delay and maximum iterations, or a later workflow invocation, to check status. Branch on the API's terminal success/failure state. Stop polling on failure or cancellation, and request results after completion.

If a submission times out or loses its connection, check your RunComfy dashboard before retrying: the service may have accepted the job. Repeating a submission can create duplicate charges. Status and result requests use the original job ID. There is no webhook or arbitrary URL-fetching tool.

Returned media and model artifact URLs may be temporary or grant access to private outputs. Treat them as account data and share only as intended. The plugin returns URLs as JSON; it does not download or store the resulting files in Dify.

## Security and privacy

The plugin uses fixed HTTPS API hosts, validates route identifiers, rejects redirects, limits input size, and applies a 10-second connection timeout with a 30-second per-request timeout. It has no Dify storage, app/model invocation, endpoint, or filesystem permission. Tokens are read from Dify credentials and sent only as bearer authorization to the three RunComfy API hosts. It does not print credentials, record request bodies, or echo raw API error bodies.

Generation, ComfyUI workflow definitions, and training configuration are sent to RunComfy for execution. That remote execution and the account charges are the material write capabilities. See [PRIVACY.md](PRIVACY.md) for data handling and [DEVELOPMENT.md](https://github.com/runcomfy-com/runcomfy-mcp/blob/codex/dify-marketplace-plugin/integrations/dify/DEVELOPMENT.md) in the public source for tests, packaging, and review instructions.
