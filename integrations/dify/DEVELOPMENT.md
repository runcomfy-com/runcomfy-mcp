# Development and marketplace review

This directory is a self-contained Dify Tool plugin. The repository's MCP backend is not part of its package. Use Python 3.12 and the official [Dify plugin CLI](https://github.com/langgenius/dify-plugin-daemon/releases).

```sh
cd integrations/dify
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest==8.4.2
.venv/bin/python -m pytest tests -q
```

Tests use mock HTTP transports and do not access real credentials or create paid jobs. Model/Trainer API payloads follow this repository's `runcomfy_client.py` and `server.py`. ComfyUI uses the current `/prod/v2` [Serverless API](https://docs.runcomfy.com/serverless/async-queue-endpoints); the older MCP client still uses v1 for queue calls. Credential validation follows the [documented account balance shape](https://docs.runcomfy.com/account/balance).

## Dify Cloud verification

Install the local package through **Plugins → Install plugin → Local package file**. Alternatively, get a remote debug address/key from the Dify Plugins page and set `INSTALL_METHOD=remote`, `REMOTE_INSTALL_URL`, and `REMOTE_INSTALL_KEY` in an ignored local `.env` file; then run `.venv/bin/python -m main` from this directory. Keep keys out of source and terminal output.

Use a dedicated RunComfy test credential in the provider's secret field. Validate credentials, browse models, inspect one model schema, and inspect existing deployments. Run one authorized inexpensive image-generation example using its actual schema, poll the same request ID to completion, and retrieve results. Verify video, workflow and training tools with authorized account resources before claiming those live checks in the submission. Mock coverage is not a substitute for Dify runtime testing. Capture only redacted evidence, with no token or private training configuration.

## Packaging and validation

Run from the repository root:

```sh
dify plugin package integrations/dify -o runcomfy-0.1.0.difypkg
python3 /path/to/dify-marketplace-toolkit/validator/validate-difypkg.py \
  runcomfy-0.1.0.difypkg --output-dir /path/to/validation-report \
  --pr-body-file /path/to/submission-body.md
```

The `.difyignore` excludes tests, development docs, local environments, logs, caches, and credentials. Inspect the archive before publishing. Submit only one `.difypkg` file per PR to `langgenius/dify-plugins`, under `runcomfy-com/runcomfy/`. Copy the current upstream PR template, accurately describe completed testing, and preserve its fields.

## Risk disclosure

The plugin sends user content to RunComfy and creates paid jobs. ComfyUI workflows and AI Toolkit configurations are executed remotely by the RunComfy service. Disclose this remote execution conservatively as **High risk**, with the following boundary: the plugin has no local code/command execution, SQL, SSH/SFTP, browser automation, filesystem operations, arbitrary URL fetching, or dynamic base URL. The only destinations are the three manifest-declared HTTPS API hosts. Route identifiers are validated; media URLs are forwarded as API payload data, never fetched by the plugin. There are no automatic retries or unbounded polling. Submission tools require the explicit paid-run setting.

The public source URL currently names the release branch so reviewers can inspect the exact implementation before merge. Update it to a release tag after the source PR is merged and tag that version before publishing a subsequent package. Do not alter package bytes after reporting its checksum without rebuilding and revalidating.
