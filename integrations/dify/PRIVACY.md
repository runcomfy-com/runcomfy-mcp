# RunComfy Dify plugin privacy

This policy covers the open-source RunComfy Dify Tool plugin. RunComfy's service policy is available at [RunComfy Privacy Policy](https://www.runcomfy.com/legal/privacy). Contact [hi@runcomfy.com](mailto:hi@runcomfy.com) with questions or deletion requests.

## Data sent to RunComfy

When you use a tool, the plugin sends the relevant input to RunComfy: search terms, model IDs, generation prompts and parameters, supplied media URLs, deployment and job identifiers, ComfyUI workflow JSON/overrides, or AI Toolkit training YAML. The RunComfy API token configured in Dify is sent in the HTTPS Authorization header. Account credential validation requests your RunComfy balance without starting a paid job.

The plugin itself connects only to `api.runcomfy.net`, `model-api.runcomfy.net`, and `trainer-api.runcomfy.net`. Generation/training services may process supplied media URLs or model inputs as part of your requested RunComfy job. Do not submit private information you do not intend RunComfy to process. Do not embed API credentials in prompts, workflow payloads, or training YAML.

## Storage, logs, and outputs

The plugin does not maintain its own database, persistent storage, analytics, tracking, or request logs. It does not download input or output files. It returns job metadata, generation outputs and artifact URLs to Dify, where your application's normal workflow history and logging settings apply. Dify manages the configured credential. Credentials and inputs are used in memory during each tool request. Raw upstream error bodies are not exposed in tool errors; reflected copies of the current API token are redacted from successful JSON responses.

RunComfy processes and retains account, billing, job, dataset, and output information according to its service privacy policy and your account settings. This plugin does not impose a separate retention schedule or delete service records. Result URLs may grant access to your outputs; treat them as private unless you intend to share them.

## Control

You choose which tools to invoke and must enable paid submissions in each relevant Dify tool's settings. Revoke the API token in RunComfy or remove the Dify credential to stop future authenticated use. Existing jobs and their billing are managed in RunComfy. For data removal beyond Dify's own workflow history, use RunComfy account controls or contact support.
