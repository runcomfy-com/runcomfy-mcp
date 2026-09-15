# RunComfy for Zapier

Generate AI images and videos and run ComfyUI workflows from Zapier. Select a current image or video model, fill its actual input fields, submit a request, and retrieve the output URLs in later steps.

RunComfy offers FLUX, Seedream, Wan, Seedance, LTX, and other image and video model families. Availability, input fields, and pricing come from the live [Models API](https://docs.runcomfy.com/model-apis/quickstart). The integration does not hard-code model versions.

## Actions

| Action | What it does |
| --- | --- |
| Generate Image or Video | Select a model and submit one paid generation request. Returns `request_id`, `model_id`, and `service` immediately. |
| Run ComfyUI Workflow | Submit one paid request to an existing serverless deployment with optional workflow input overrides. Returns `request_id`, `deployment_id`, and `service` immediately. |
| Get Request Status | Read the status of a generation or ComfyUI request once. |
| Get Request Result | Retrieve its result and a convenient `output_urls` list. |

Model and deployment dropdowns read your available resources. Model inputs are generated from the selected model's JSON Schema and validated before a paid request is sent. Complex inputs, including supported LoRA inference options, accept JSON. This release does not create datasets, start LoRA training, create deployments, or change GPU settings.

## Connect your account

1. Sign into [RunComfy](https://www.runcomfy.com/auth/sign-in).
2. Create or copy an API token from your [Profile](https://www.runcomfy.com/profile).
3. In the Zapier RunComfy connection, enter the token without the `Bearer` prefix.

Connecting uses the read-only balance endpoint. A token is required even for free discovery and status operations. Generation and ComfyUI execution use your RunComfy balance; prices depend on the selected model or deployment. Zapier plan/task charges are separate.

## Generate an image or video

1. Add **Generate Image or Video** to your Zap.
2. Optionally enter a model keyword, then refresh the Model dropdown. Choose an image or video model; you can also enter the model ID from [RunComfy Models](https://www.runcomfy.com/models) as a custom value.
3. Fill the displayed prompt, source image/video URLs, dimensions, duration, or other fields required by that model. File URLs must be publicly accessible HTTPS URLs.
4. Review the price and set **Confirm Paid Request** to Yes.
5. Map the returned **Request ID** and **Request Type** into later status and result actions.

**Testing this action submits a real paid request.** It does not wait for rendering to finish. Its successful result confirms submission only.

## Run a ComfyUI workflow

Create a serverless deployment in RunComfy first. Choose it in **Run ComfyUI Workflow**, then optionally provide node input overrides from that deployment's API page:

```json
{"6":{"inputs":{"text":"A red sneaker on a white background"}}}
```

Your deployment determines the correct node IDs and fields; the example above is illustrative. A complete ComfyUI API-format workflow can also be supplied. Set **Confirm Paid Request** to Yes to submit. Keep the returned deployment ID together with its request ID.

## Handle asynchronous results

A typical Zap submits a request, uses **Delay by Zapier**, then checks **Get Request Status**. Continue to **Get Request Result** when status is `completed`. If it is still queued or in progress, schedule another read of the same request. Handle `failed` or `cancelled` separately.

Each status/result action performs one read. It does not block until completion, poll in a loop, or trigger a new generation. A single fixed delay cannot guarantee completion: rendering time varies by model and workload. Arrange repeated status checks in your automation when unattended completion is required.

Use `output_urls` from the result to pass generated media to your next step. Outputs remain available in the original `output` (Model API) or `outputs` (ComfyUI API) field too. Request IDs from one API cannot be used with the other; mapping **Request Type** avoids that mistake.

Do not automatically replay a failed submit step without checking RunComfy. A timeout or connection error may occur after the API accepts the job; executing it again can create another paid request. After a paid submit attempt, network errors, API failures, invalid JSON, and malformed acknowledgements stop that run with Zapier's `HaltedError`, preventing AutoReplay of that uncertain submission. Check RunComfy before deliberately running the action again. This integration does not claim API idempotency.

## Develop and test

This folder is a standalone Zapier Platform CLI project inside the public RunComfy MCP repository. It uses the documented production REST APIs directly and does not require changes to the hosted MCP server.

```sh
npm ci
npm test
npm run validate
npm run build
```

Tests mock HTTP requests and disable outbound network access. They cover authentication, HTTP-200 API errors, model schema validation, typed inputs, explicit billing consent, both API families, output URLs, redirect blocking, and uncertain submission outcomes. They create no paid jobs.

`npm run validate` runs local schema validation. `npx zapier-platform validate` also runs Zapier's remote integration checks. `npm run build` produces ignored `build/build.zip` and `build/source.zip` archives.

Authentication and marketplace review in a real Zapier account remain separate from these local checks. See [SUBMISSION.md](SUBMISSION.md) for publishing steps.

## Documentation and support

- [RunComfy](https://www.runcomfy.com)
- [Model API](https://docs.runcomfy.com/model-apis/quickstart)
- [ComfyUI Serverless API](https://docs.runcomfy.com/serverless/introduction)
- [Privacy policy](https://www.runcomfy.com/legal/privacy)
- Support: hi@runcomfy.com
