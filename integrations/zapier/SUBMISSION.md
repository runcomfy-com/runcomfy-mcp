# Zapier submission checklist

## Listing copy

- **Name:** RunComfy
- **Homepage:** https://www.runcomfy.com
- **Description:** RunComfy is an AI image and video generator for FLUX, Wan, Seedance, Seedream, and LTX, with ComfyUI workflows and GPU LoRA training.
- **Support email:** hi@runcomfy.com
- **API documentation:** https://docs.runcomfy.com

The description describes the RunComfy product. Version 1.0.1 exposes image/video generation and existing ComfyUI workflows, plus status/result retrieval. Starting training is not included in this Zapier release. Model versions are discovered live rather than claimed as permanently supported.

## Upload this version

1. Sign into the existing RunComfy app in the [Zapier Developer Platform](https://developer.zapier.com/). Do not register a duplicate app.
2. Configure a Zapier deploy key locally. The supported CLI command is `npx zapier-platform login --sso`; it directs you to [Deploy Keys](https://developer.zapier.com/partner-settings/deploy-keys/). The deploy-key prompt is ordinary visible input, so keep it out of recorded sessions. Alternatively, supply an existing secure file through `ZAPIER_AUTH_LOCATION`.
3. Run `npx zapier-platform link` and choose that existing RunComfy app.
4. Run `npm test`, `npm run validate`, and `npx zapier-platform push` from this folder. Version 1.0.1 leaves the initial 1.0.0 UI draft intact.
5. Review the uploaded version and connected-account experience in Zapier before promoting or submitting it.

`.zapierrc`, `.env`, build archives, and this checkout's local app link are ignored. Never put a deploy key or RunComfy token into source, an action input field, or a public issue/PR.

## Required live validation before marketplace submission

- Connect a real RunComfy account with its API token.
- Verify model dropdown pagination, model search, dynamic input fields, and account-specific deployment choices in the Zap editor.
- Create and turn on test Zaps for **every visible action**, with at least one successful retained Zap-history run for each action. Test both image and video generation as well as ComfyUI execution and both result families.
- Confirm paid action tests with the owner, use an appropriate funded test account, and retain request IDs and output proof without credentials.
- Keep the test Zaps and their history available for Zapier review.
- Provide a non-expiring RunComfy reviewer account using **integration-testing@zapier.com**, with access to the required features and no trial limitations. Supply its credentials only through Zapier's confidential review fields.
- Include at least one integration admin whose email domain belongs to RunComfy or its owning company.
- Set brand assets, category, support links, and final public description in the platform. Add user documentation and useful Zap templates.
- Run the publishing checks, address errors and publishing tasks, then submit the same RunComfy app for review.

The source and mocked tests alone do not satisfy live-Zap publishing requirements. Do not report marketplace submission, approval, or successful paid execution until the corresponding platform step has been verified.

## Expected non-blocking check notes

- `request_id` is mapped from the submission result. The documented APIs do not expose an account-wide inference request list for a dropdown.
- The optional connection label is omitted because the safe balance authentication endpoint does not return a non-sensitive account display name. It must never be replaced by a token or token fragment.

## Official sources

Checked September 2026:

- [Publishing requirements](https://docs.zapier.com/integrations/publish/integration-publishing-requirements)
- [CLI tutorial](https://docs.zapier.com/integrations/quickstart/cli-tutorial)
- [Dynamic fields](https://docs.zapier.com/integrations/build-cli/input-fields)
- [Dynamic dropdowns](https://docs.zapier.com/integrations/build-cli/dynamic-dropdowns)
- [Operating constraints](https://docs.zapier.com/integrations/build/operating-constraints)

Endpoint and payload contracts follow RunComfy's current API documentation. Serverless inference/status/result use `/prod/v2`, as required for new integrations. Model API uses `/v1`. The public MCP client is also useful reference material, but its older Serverless `/prod/v1` paths are not copied into this integration.
